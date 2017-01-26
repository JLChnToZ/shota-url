var path = require('path');
var fs = require('fs');
var _ = require('underscore');
var sync = require('sync');
var express = require('express');
var bodyParser = require('body-parser');
var mongoose = require('mongoose');
var handlebars = require('handlebars');
var SelfReloadJson = require('self-reload-json');
var Hashids = require('hashids');
var marked = require('marked');
var minify = require('html-minifier').minify;

var matcher = require('./static/assets/shared/matcher');

function backgroundHandler(err) {
  if(err) console.log(err.stack || err);
}

// Load config
var config = new SelfReloadJson(path.resolve(__dirname, 'config.json'));
var removalHashGen = new Hashids(config.removeHashSalt || 'removeshota');
var createIdHash = new Hashids(config.linkHashSalt || 'shota', 10);

// Initialize mongoose schema
mongoose.connect(config.db || 'mongodb://localhost/shotaurl');
var Entry = mongoose.model('urlentries', {
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
var indexPage = handlebars.compile(fs.readFileSync(path.resolve(__dirname, 'templates/index.mustache'), 'utf8'));
var landingPage = handlebars.compile(fs.readFileSync(path.resolve(__dirname, 'templates/landing.mustache'), 'utf8'));

// Initialize express
var app = express();
app.disable('x-powered-by');
app.use(bodyParser.json());
app.use(express.static(path.resolve(__dirname, 'static')));

app.get('/', function(req, res) {
  res.send(minify(indexPage({ config: config }), config.minifyOptions));
});

var inuseId = 0;
app.post('/add', function(req, res) {
  sync(function() {
    var id = Date.now();
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
    var entry = new Entry(req.body);
    var errors = entry.validateSync();
    if(errors) throw errors;
    entry.save.sync(entry);
    return {
      id: req.body.id,
      removeId: req.body.rid
    };
  }, function(err, resp) {
    if(err) {
      res.send({ error: err.message });
      return;
    }
    res.send(resp);
  });
});

app.get('/check/:id', function(req, res) {
  sync(function() {
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
    return !Entry.findOne.sync(Entry, { id: req.params.id });
  }, function(err, result) {
    res.send({
      id: req.params.id,
      available: !!result
    });
  });
});

app.get('/remove/:remid', function(req, res) {
  sync(function() {
    var entry = Entry.findOne.sync(Entry, { rid: req.params.remid });
    if(!entry)
      return false;
    entry.remove.sync(entry);
    return true;
  }, function(err, resp) {
    res.send({ success: !err && resp }).end();
  });
});

app.get('/:id', function(req, res) {
  sync(function() {
    var entry = Entry.findOne.sync(Entry, { id: req.params.id });
    if(!entry || (entry.clickCount < 1 && entry.clickCount !== -1) || entry.removalTime <= new Date()) {
      if(entry) entry.remove(backgroundHandler);
      return { http: 404 };
    }
    if(entry.clickCount !== -1)
      entry.clickCount--;
    if(!entry.consistantDuration)
      entry.removalTime = new Date(Date.now() + entry.removalDuration);
    entry.save(backgroundHandler);
    var data = { pages: [], random: entry.randomize, config: config, comments: entry.comments };
    var i, l = entry.targets.length;
    if(entry.randomize && l) {
      var totalWeight = 0, rand = 0, currentWeight = 0;
      for(i = 0; i < l; i++)
        totalWeight += entry.targets[i].prob;
      if(totalWeight > 0) {
        rand = Math.random() * totalWeight;
        for(i = 0; i < l; i++) {
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
      for(i = 0; i < l; i++)
        data.pages.push(entry.targets[i].url);
    }
    if(entry.autoRedirect)
      return { http: 301, target: data.pages[0] };
    return { content: minify(landingPage(data), config.minifyOptions) };
  }, function(err, content) {
    if(err) {
      res.status(403).end();
      backgroundHandler(err);
      return;
    }
    if(content.http) {
      switch(content.http) {
        case 301: res.redirect(content.target); break;
        default: res.status(content.http).end(); break;
      }
      return;
    }
    res.send(content.content).end();
  });
});

// Run server
var server = app.listen(config.port || 3333, config.host || '127.0.0.1', function () {
  var address = server.address();
  console.log('Server start working at http://%s:%s', address.address, address.port);
});
