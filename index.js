const path = require('path');
const fs = require('fs');
const _ = require('underscore');
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const handlebars = require('handlebars');
const SelfReloadJson = require('self-reload-json');
const Hashids = require('hashids');
const marked = require('marked');
const minify = require('html-minifier').minify;

const matcher = require('./static/assets/shared/matcher');

function backgroundHandler(err) {
  if(err) console.log(err.stack || err);
}

function noop() {}

// Load config
const config = new SelfReloadJson(path.resolve(__dirname, 'config.json'));
const removalHashGen = new Hashids(config.removeHashSalt || 'removeshota');
const createIdHash = new Hashids(config.linkHashSalt || 'shota', 10);

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
    }
  }],
  removalDuration: {
    type: Number,
    min: 0,
    max: config.maxduration
  },
  removalTime: Date,
  clickCount: {
    type: Number,
    get: function(v) { return Math.round(v); },
    set: function(v) { return Math.round(v); },
    'default': -1
  },
  randomize: Boolean,
  autoRedirect: Boolean,
  consistantDuration: Boolean
});

// Load templates
handlebars.registerHelper('ifCond', function(v1, v2, options) {
  return v1 === v2 ? options.fn(this) : options.inverse(this);
});
const indexPage = handlebars.compile(fs.readFileSync(path.resolve(__dirname, 'templates/index.mustache'), 'utf8'));
const landingPage = handlebars.compile(fs.readFileSync(path.resolve(__dirname, 'templates/landing.mustache'), 'utf8'));

// Initialize express
const app = express();
app.disable('x-powered-by');
app.use(bodyParser.json());
app.use(express.static(path.resolve(__dirname, 'static')));

app.get('/', (req, res) => {
  res.send(minify(indexPage({ config: config }), config.minifyOptions));
});

let inuseId = 0;
async function add(req) {
  let id = Date.now();
  if(id === inuseId)
    id = ++inuseId;
  else
    inuseId = id;
  if(!req.body.id)
    req.body.id = createIdHash.encode(id);
  if(req.body.comments)
    req.body.comments = marked(req.body.comments);
  req.body.removalTime = new Date(Date.now() + req.body.removalDuration);
  req.body.rid = removalHashGen.encode(id);
  const entry = new Entry(req.body);
  await entry.save();
  return {
    id: req.body.id,
    removeId: req.body.rid
  };
}
app.post('/add', (req, res) => {
  add(req).then(
    resp => res.send(resp),
    err => res.send({ error: err.message })
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
    config: config,
    comments: entry.comments
  };
  const l = entry.targets.length;
  if(entry.randomize && l) {
    let totalWeight = 0, rand = 0, currentWeight = 0;
    for(let i = 0; i < l; i++)
      totalWeight += entry.targets[i].prob;
    if(totalWeight > 0) {
      rand = Math.random() * totalWeight;
      for(let i = 0; i < l; i++) {
        currentWeight += entry.targets[i].prob;
        if(currentWeight > rand) {
          data.pages.push(entry.targets[i].url);
          break;
        }
      }
    }
    if(data.pages.length < 1)
      data.pages.push(entry.targets[Math.floor(Math.random() * l)].url);
  } else {
    for(let i = 0; i < l; i++)
      data.pages.push(entry.targets[i].url);
  }
  if(entry.autoRedirect)
    return { http: 301, target: data.pages[0] };
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
