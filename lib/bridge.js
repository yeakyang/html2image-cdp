/**
 * Bridge
 */

const URL = require('url');
const path = require('path');
const lodash = require('lodash');
// const Promise = require('bluebird');
const EventEmitter = require('events');
const CDP = require('chrome-remote-interface');

class Bridge extends EventEmitter {
    constructor(options) {
        super();

        this._clientCount = 0;

        this._options = {
            host: 'localhost',
            port: 9222,
            secure: false
        };

        this.setOptions(options);
    }

    get clientCount() {
        return this._clientCount;
    }

    get options() {
        return lodash.clone(this._options);
    }

    set options(options) {
        this._options = options;
    }

    setOptions(options) {
        if(typeof options === 'string') {
            const url = URL.parse(options);

            options = {
                secure: url.protocol === 'wss',
                host: url.hostname,
                port: url.port
            };
        }

        return lodash.assign(this._options, options);
    }

    getTargets() {
        return CDP.List(this.options)
        .then(targets => {
            this.targets = targets;

            return targets;
        });
    }

    createClient() {
        const options = this.options;

        this._clientCount += 1;

        return CDP.New(options)
        .then(target => {
            const options = lodash.defaults(this.options, {
                target: target.webSocketDebuggerUrl
            });

            return CDP(options);
        })
        // hack client
        .then(client => {
            const bridge = this;

            client.emit('disconnect', () => {
                this.emit('client.close', client);
            });

            client._ws.on('error', () => {
                this.emit('client.error', client);
            });

            // Shim .close
            // client only use once
            const _close = client.close;
            client.close = function(...args) {
                return _close.apply(this, args)
                .then(() => {
                    return bridge.closeClient(this.target);
                });
            };

            return client;
        })
        .catch(err => {
            this._clientCount -= 1;

            throw err;
        });
    }

    closeClient(id) {
        const options = lodash.defaults(this.options, {
            id: path.basename(id || '')
        });

        return CDP.Close(options)
        .then(() => {
            this._clientCount = Math.max(0, this._clientCount - 1);
        });
    }

    openPage(url, options = {}) {
        let client;

        return this.createClient()
        .then(clt => {
            client = clt;

            // viewport
            const viewport = options.viewport || {
                height: 600,
                width: 800
            };

            // setup
            return Promise.all([
                client.DOM.enable(),
                client.Page.enable(),
                client.Network.enable(),
                client.Runtime.enable(),
                client.Emulation.setVisibleSize({
                    height: viewport.height,
                    width: viewport.width
                })
            ]);
        })
        .then(() => {
            const rAbsUrl = /^\w+:\/\//;
            if(!rAbsUrl.test(url)) {
                url = 'file://' + path.resolve(url);
            }

            return client.Page.navigate({
                url
            });
        })
        .then(() => {
            return new Promise((resolve) => {
                client.Page.loadEventFired(() => {
                    resolve();
                });
            });
        })
        .then(() => {
            return client;
        });
    }

    querySelectorAllByClient(client, selector) {
        const DOM = client.DOM;

        return DOM.getDocument()
        .then(doc => {
            const rootNodeId = doc.root.nodeId;

            return DOM.querySelectorAll({
                selector: selector,
                nodeId: rootNodeId
            });
        });
    }
}

module.exports = Bridge;