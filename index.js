/**
 * index
 */

// env
require('./env');

// deps
const Koa = require('koa');
const Router = require('koa-router');
const favicon = require('koa-favicon');
const onerror = require('koa-onerror');
const path = require('path');

// logger
const logger = require('./services/logger');

// init app, whit proxy
const app = new Koa();
app.proxy = true;

// 404
app.use(function *(next) {
    yield * next;

    if(this.status === 404 && this.body === undefined) {
        this.throw(404);
    }
});

// favicon
// maxAge, 1 month
app.use(favicon(path.join(__dirname, '../favicon.ico'), {
    maxAge: 30 * 24 * 60 * 60 * 1000
}));

// init router
app.router = new Router();

// controllers
require('./controllers/index').forEach(ctrlFactory => {
    ctrlFactory(app, app.router);
});

// use routers
app.use(app.router.routes());


// Error handle
app.handleError = function(err, ctx) {
    let data = err.data || {};
    let statusCode = err.status;

    ctx.status = statusCode || 500;
    data.status = ctx.status;

    if(!data.message) {
        data.message = err.message;
    }

    if(app.env === 'development') {
        data.stack = err.stack.split('\n');
    }

    return data;
};
onerror(app, {
    template: path.join(__dirname, '../views/www/error.html'),
    accepts() {
        let type = this.accepts(['json', 'html']);

        if(type !== 'html') {
            type = 'json';
        }

        return type;
    },
    json(err) {
        let data = app.handleError(err, this);

        this.body = data;
    },
    html(err) {
        let data = app.handleError(err, this);

        // this.body = this.render('error', {
        //     env: process.env,
        //     error: err.message,
        //     status: this.status,
        //     code: err.code,
        //     data: data
        // });

        this.body = `<!DOCTYPE html><html>
            <head><meta charset="UTF-8"/><title>${err.message}-${this.status}</title></head><body>
            <h1>${err.message}-${this.status}</h1><p><pre>${JSON.stringify(data, null, 2)}</pre></p>
            </body></html>`;
    }
});

// Error report
app.on('error', (err, ctx) => {
    let meta = err.data;

    // axios request error
    let response = err.response;
    if(response) {
        meta = response.data;

        if(meta) {
            err.message += ': ' + meta.message;
        }
    }

    err.data = {
        url: ctx.url,
        method: ctx.method,
        status: err.status || err.statusCode || ctx.status,
        meta: meta ? JSON.stringify(meta) : null,
        referer: ctx.get('Referer'),
        ua: ctx.get('User-Agent'),
        ip: ctx.ip
    };

    logger.error(err, err.data);
});

// process.crash
process.on('uncaughtException', ex => {
    logger.info(ex.message, null, 'app.crashed');
    logger.error(ex);

    process.exit(1);
});


// start up
let port = process.env.PORT || 3007;

app.listen(port);
logger.info('Server Start...', {
    port: port,
    www: 'http://' + process.env.WWW_HOST
});

// exports
module.exports = app;