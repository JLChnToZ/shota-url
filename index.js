const path = require('path');
const fs = require('fs');
const url = require('url');
const util = require('util');
const express = require('express');
const bodyParser = require('body-parser');
const { Recaptcha } = require('express-recaptcha');
const mongoose = require('mongoose');
const handlebars = require('handlebars');
const SelfReloadJson = require('self-reload-json');
const Hashids = require('hashids');
const marked = require('marked');
const og = require('open-graph');
const { minify } = require('html-minifier');

const matcher = require('./static/assets/shared/matcher');

function backgroundHandler(err) {
  if(err) console.log(err.stack || err);
}

function noop() {}

// Load config
const config = new SelfReloadJson(path.resolve(__dirname, 'config.json'));
const removalHashGen = new Hashids(config.removeHashSalt || 'removeshota');
const createIdHash = new Hashids(config.linkHashSalt || 'shota', 10);
const recaptcha = config.recapcha && new Recaptcha(config.recapcha.publickey, config.recapcha.secretkey);
if(recaptcha) recaptcha.verifyPromise = util.promisify(recaptcha.verify);

// Initialize mongoose schema
mongoose.connect(config.db || 'mongodb://localhost/shotaurl');
const Entry = mongoose.model('urlentries', {
  rid: { type: String, index: true, unique: true },
  id: { type: String, index: true, unique: true, match: matcher.id },
  comments: { type: String, default: '' },
  targets: [{
    url: { type: String },
    prob: {
      type: Number,
      min: 0,
      'default': 1
    },
    og: { type: mongoose.Schema.Types.Mixed },
    preview: { type: Buffer },
  }],
  removalDuration: {
    type: Number,
    min: 0,
    max: config.maxduration
  },
  removalTime: {
    type: Date,
    expires: 1
  },
  clickCount: {
    type: Number,
    get: function(v) { return Math.round(v); },
    set: function(v) { return Math.round(v); },
    'default': -1
  },
  randomize: Boolean,
  autoRedirect: Boolean,
  consistantDuration: Boolean,
  og: Number,
});

// Load templates
handlebars.registerHelper('ifCond', function(v1, v2, options) {
  return v1 === v2 ? options.fn(this) : options.inverse(this);
});
handlebars.registerHelper('attrs', function(value) {
  if(arguments.length < 2) return '';
  let result = '';
  for(let attr in value)
    if(value[attr] !== undefined && value[attr] !== null)
      result += `${
        result ? ' ' : ''
      }${
        handlebars.escapeExpression(attr)
      }="${
        handlebars.escapeExpression(value[attr])
      }"`;
  return new handlebars.SafeString(result);
});
handlebars.registerHelper('json', function(value, space) {
  if(arguments.length < 2) return '';
  return JSON.stringify(value, null, arguments.length > 2 && space || '');
});
const indexPage = handlebars.compile(fs.readFileSync(path.resolve(__dirname, 'templates/index.mustache'), 'utf8'));
const landingPage = handlebars.compile(fs.readFileSync(path.resolve(__dirname, 'templates/landing.mustache'), 'utf8'));

// Initialize express
const app = express();
app.disable('x-powered-by');
app.use(bodyParser.json());
app.use(express.static(path.resolve(__dirname, 'static')));

if(recaptcha) app.use('/', recaptcha.middleware.render);
app.get('/', (req, res) => {
  res.send(minify(indexPage({ config, capcha: res.recaptcha }), config.minifyOptions));
});

let inuseId = 0;
async function add(req) {
  let id = Date.now();
  if(id === inuseId)
    id = ++inuseId;
  else
    inuseId = id;
  if(recaptcha)
    await recaptcha.verifyPromise(req);
  if(!req.body.id)
    req.body.id = createIdHash.encode(id);
  if(req.body.comments)
    req.body.comments = marked(req.body.comments);
  req.body.removalTime = new Date(Date.now() + req.body.removalDuration);
  req.body.rid = removalHashGen.encode(id);
  await Promise.all(req.body.targets.map(mapOg, req.body));
  await new Entry(req.body).save();
  return {
    id: req.body.id,
    removeId: req.body.rid
  };
}
const ogParse = util.promisify(og);
async function mapOg(target) {
  if(this.og) 
    try {
      delete target.preview;
      target.og = await ogParse(target.url);
      if(target.og && this.og < 0) {
        // Remove all meta if exists
        delete target.og.image;
        delete target.og.video;
        delete target.og.audio;
      }
    } catch(e) {}
  else {
    delete target.og;
    delete target.preview;
  }
  return target;
}
app.post('/add', (req, res) => {
  add(req).then(
    resp => res.send(resp),
    err => res.send({ error: err.message || err || 'Unknown Error' })
  );
});

async function check(req) {
  if(!req.params.id.match(matcher.id))
    return false;
  switch(req.params.id.toLowerCase()) {
    case 'add':
    case 'check':
    case 'assets':
    case 'remove':
    case 'preview':
    case 'favicon.ico':
      return false;
  }
  return !await Entry.findOne({ id: req.params.id });
}
app.get('/check/:id', (req, res) => {
  check(req).catch(noop).then(
    result => res.send({
      id: req.params.id,
      available: !!result
    })
  );
});

async function remove(req) {
  const entry = await Entry.findOne({ rid: req.params.remid });
  if(!entry) return false;
  await entry.remove();
  return true;
}
app.get('/remove/:remid', (req, res) => {
  remove(req).catch(noop).then(
    resp => res.send({ success: resp }).end()
  );
});

app.get('/preview/:id/:i', async(req, res) => {
  const entry = await Entry.findOne({ rid: req.params.id });
  if(!entry || i < 0 || i >= entry.length || !entry[i].preview)
    return res.status(404).end('No such preview');
  res.type('png');
  res.send(entry[i].preview);
});

const flattenShortcut = Object.freeze({
  'og:image:url': 'og:image',
  'og:video:url': 'og:video',
  'og:audio:url': 'og:audio',
});
const altMetaNames = Object.freeze({
  'og:description': 'description'
});
function flattenMeta(src, originalUrl) {
  if(!src) return [];
  const temp = [{ property: 'og', content: src }], result = [];
  while(temp.length) {
    const { property, content } = temp.pop();
    for(let key in content) {
      const newName = `${property}:${key}`;
      if(newName === 'og:url')
        content[key] = url.resolve(config.siteroot, originalUrl);
      (typeof content[key] === 'object' ? temp : result).push({
        property: flattenShortcut[newName] || newName,
        name: altMetaNames[newName],
        content: content[key]
      });
    }
  }
  return result;
}
function mapLinks(page) {
  return page.url;
}
async function getId(req) {
  const entry = await Entry.findOne({ id: req.params.id });
  if(!entry || (entry.clickCount < 1 && entry.clickCount !== -1) || entry.removalTime <= new Date()) {
    if(entry) entry.remove(backgroundHandler);
    return { http: 404 };
  }
  if(entry.clickCount !== -1)
    entry.clickCount--;
  if(!entry.consistantDuration)
    entry.removalTime = new Date(Date.now() + entry.removalDuration);
  entry.save(backgroundHandler);
  const data = {
    pages: [],
    random: entry.randomize,
    config,
    comments: entry.comments
  };
  const targetsCount = entry.targets.length;
  if(entry.randomize && targetsCount) {
    let totalWeight = 0, rand = 0, currentWeight = 0;
    for(let i = 0; i < targetsCount; i++)
      totalWeight += entry.targets[i].prob;
    if(totalWeight > 0) {
      rand = Math.random() * totalWeight;
      for(let i = 0; i < targetsCount; i++) {
        currentWeight += entry.targets[i].prob;
        if(currentWeight > rand) {
          data.pages.push(entry.targets[i]);
          break;
        }
      }
    }
    if(data.pages.length < 1)
      data.pages.push(entry.targets[Math.floor(Math.random() * targetsCount)]);
  } else {
    data.pages = entry.targets;
  }
  if(entry.autoRedirect)
    return { http: entry.randomize && targetsCount ? 302 : 301, target: data.pages[0].url };
  data.links = data.pages.map(mapLinks);
  for(const page of data.pages)
    if(page.og) {
      data.og = flattenMeta(page.og, req.originalUrl);
      break;
    }
  return { content: minify(landingPage(data), config.minifyOptions) };
}
app.get('/:id', (req, res) => {
  getId(req).then(
    content => {
      if(content.http) {
        switch(content.http) {
          case 301: res.redirect(content.target); break;
          default: res.status(content.http).end(); break;
        }
        return;
      }
      res.send(content.content).end();
    },
    err => {
      res.status(403).end();
      backgroundHandler(err);
    }
  );
});

// Run server
const server = app.listen(config.port || 3333, config.host || '127.0.0.1', () => {
  const address = server.address();
  console.log('Server start working at http://%s:%s', address.address, address.port);
});
