var fs = require('fs');
var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var {ParseServer} = require('parse-server');
var oauthshim = require('oauth-shim');
const config = JSON.parse(fs.readFileSync('./config.json'));
var api = new ParseServer(config.parseConfig);
var app = express();

// setup livequery server
const server = require('http').createServer(app);
server.listen(8080);

const parseLiveQueryServer = ParseServer.createLiveQueryServer(server);

oauthshim.init([
  {
    client_id: config.githubConfig.clientId,
    client_secret: config.githubConfig.clientSecret,
    grant_url: 'https://github.com/login/oauth/access_token'
  }
]);

app.get('/', (req, res) => {
  res.render('index', {
    githubClientId: config.githubConfig.clientId,
    parseAppId: config.parseConfig.appId
  });
});
app.use('/parse', api);
app.use('/proxy', oauthshim);
app.listen(1337, function() {
  console.log('parse-server running on port 1337.');
});

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use(function(req, res, next) {
  next(createError(404));
});
app.use(function(err, req, res) {
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
