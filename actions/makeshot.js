/**
 * actions/makeshot
 */

const path = require('path');
const sharp = require('sharp');
const fsp = require('fs-extra');
const lodash = require('lodash');
const Promise = require('bluebird');

const cpuCount = require('os').cpus().length;
const clearTimeoutShots = require('../services/clear-timeout-shots');
const bridge = require('../services/bridge');
const logger = require('../services/logger');
const wait = require('../lib/wait-promise');

const env = process.env;
const SHOT_CACHE_CHECK_INTERVAL = +env.SHOT_CACHE_CHECK_INTERVAL || 0;
const SHOT_WAIT_MAX_TIMEOUT = +env.SHOT_WAIT_MAX_TIMEOUT || 10000;
const SHOT_IMAGE_MAX_HEIGHT = +env.SHOT_IMAGE_MAX_HEIGHT || 8000;
const SHOT_IMAGE_MAX_WIDTH = +env.SHOT_IMAGE_MAX_WIDTH || 5000;

const shotCounts = Object.defineProperties({}, {
    success: {
        enumerable: true,
        writable: true,
        value: 0
    },
    error: {
        enumerable: true,
        writable: true,
        value: 0
    },
    total: {
        enumerable: true,
        get() {
            return this.success + this.error;
        }
    }
});

const makeshot = (cfg, hooks) => {
    const startTimestamp = Date.now();
    let client = null;

    const traceInfo = (type, metadata) => {
        const msg = `Makeshot.${type}`;
        const elapsed = Date.now() - startTimestamp;
        const lastMs = traceInfo.lastMs || 0;

        traceInfo.lastMs = elapsed;

        return logger.info(msg, lodash.assign({
            shot_id: cfg.id,
            shot_url: cfg.url,
            selector: cfg.wrapSelector,
            last_elasped: elapsed - lastMs,
            elapsed: elapsed
        }, metadata));
    };

    const calcRects = () => {
        if(cfg.skipImagesShot) {
            return Promise.resolve([]);
        }

        return Promise.try(() => {
            traceInfo('page.startClacRects');

            const getClipRectsCode = `
                var selector = '${cfg.wrapSelector}';
                var wrapMaxCount = +${cfg.wrapMaxCount} || 0;
                var elems = [].slice.call(document.querySelectorAll(selector));
                var len = wrapMaxCount > 0 ? Math.min(wrapMaxCount, elems.length) : elems.length;
                var clipRects = [];

                for(var i=0; i < len; i++) {
                    var rect = elems[i].getBoundingClientRect();

                    clipRects.push({
                        width: rect.width,
                        height: rect.height,
                        bottom: rect.bottom,
                        right: rect.right,
                        left: rect.left,
                        top: rect.left
                    });
                }

                JSON.stringify(clipRects);
            `;

            return client.evaluate(getClipRectsCode);
        })
        .then(result => {
            return JSON.parse(result.value);
        })
        .map((rect, idx) => {
            // Round down and ensure rect has size
            rect.height = Math.max(1, Math.floor(rect.height));
            rect.width = Math.max(1, Math.floor(rect.width));

            traceInfo(`page.getClipRect-${idx}`, rect);

            return rect;
        });
    };

    const shotImages = (rects = []) => {
        if(cfg.skipImagesShot) {
            return Promise.resolve([]);
        }

        return Promise.try(() => {
            return rects;
        })
        // hook: beforeShot
        .tap(() => {
            return hooks.beforeShot(client);
        })
        // Clac viewport
        .tap(rects => {
            const viewport = cfg.viewport;
            let viewHeight = viewport[1];
            let viewWidth = viewport[0];

            // x use right, y use height by elem.scrollIntoView
            rects.forEach(rect => {
                if(rect.right > viewWidth) {
                    viewWidth = rect.right;
                }
                if(rect.height > viewHeight) {
                    viewHeight = rect.height;
                }
            });

            // log
            traceInfo('client.setVisibleSize', {
                visibleSize: [viewWidth, viewHeight],
                viewport: viewport
            });

            if(viewWidth > SHOT_IMAGE_MAX_WIDTH || viewHeight > SHOT_IMAGE_MAX_HEIGHT) {
                const maxSize = `${SHOT_IMAGE_MAX_WIDTH}x${SHOT_IMAGE_MAX_HEIGHT}`;

                throw new Error(`Request Image size is out of limit: ${maxSize}`);
            }

            return client.getVisibleSize()
            .then(size => {
                if(viewWidth > size.width || viewHeight > size.height) {
                    const height = Math.round(Math.max(viewHeight, size.height));
                    const width = Math.round(Math.max(viewWidth, size.width));

                    return client.setVisibleSize(width, height);
                }
            });
        })
        // Set background color
        .tap(() => {
            const isPng = cfg.out.imageType === 'png';
            const backgroundColor = isPng ? '#00000000' : '#FFFFFFFF';

            traceInfo('page.setBackgorundColor', {
                color: cfg.backgroundColor || backgroundColor
            });

            return client.setBackgroundColor(backgroundColor);
        })

        // Focus element and Screenshot
        .mapSeries((rect, idx) => {
            const cropRect = {
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height
            };
            const ret = {
                cropRect,
                rect
            };

            const focusElementCode = `
                var elems = document.querySelectorAll('${cfg.wrapSelector}');
                var elem = elems[${idx}];
                var offset = [0, 0];
                var data = {
                    visibleSize: [window.innerWidth, window.innerHeight],
                    elementOffset: offset
                };

                if(elem) {
                    elem.scrollIntoView();

                    var rect = elem.getBoundingClientRect();

                    offset[0] = rect.left;
                    offset[1] = rect.top;
                }

                JSON.stringify(data);
            `;

            // Set page scale
            // @TODO: 目前无效，待支持矢量缩放
            return Promise.try(() => {
                // return client.setPageScaleFactor(0.5);
            })
            // Focus element and get offset
            .then(() => {
                return client.evaluate(focusElementCode);
            })
            .then(result => {
                const data = JSON.parse(result.value);
                const offset = data.elementOffset || [0, 0];

                // Fix crop offset
                cropRect.left = Math.max(0, Math.floor(offset[0]) || 0);
                cropRect.top = Math.max(0, Math.floor(offset[1]) || 0);

                traceInfo('client.captureScreenshot-' + idx, {
                    elementOffset: data.elementOffset,
                    visibleSize: data.visibleSize,
                    cropRect: cropRect
                });

                return client.captureScreenshot({
                    // @TODO: 目前无效，待优化
                    // clip: {
                    //     height: cropRect.height,
                    //     width: cropRect.width,
                    //     y: cropRect.y,
                    //     x: cropRect.x,
                    //     scale: 1
                    // },
                    fromSurface: true,
                    format: 'png'
                });
            })
            .tap(buf => {
                traceInfo('client.captureScreenshot.done-' + idx, {
                    bufferLength: buf.length
                });
            })
            .then(buf => {
                ret.image = buf;

                return ret;
            });
        })

        // Extract image
        .map(({image, rect, cropRect}, idx) => {
            traceInfo(`client.processImage-${idx}`, { cropRect });

            image = sharp(image).extract(cropRect);

            const imageSize = cfg.imageSize || {};
            const imageWidth = +imageSize.width || null;
            const imageHeight = +imageSize.height || null;
            if(imageWidth || imageHeight) {
                const cropStrategies = sharp.gravity;
                const oldStrategiesMap = {
                    10: cropStrategies.north,
                    11: cropStrategies.northwest,
                    12: cropStrategies.northeast
                };

                let strategy = imageSize.type || imageSize.strategy;

                strategy = oldStrategiesMap[strategy] || cropStrategies[strategy];
                if(!strategy) {
                    strategy = cropStrategies.north;
                }

                image = image.resize(imageWidth, imageHeight);
                image = image.crop(strategy);
            }

            return { image, rect };
        }, {
            concurrency: cpuCount
        })

        // hooks: afterShot
        .tap(images => {
            return hooks.afterShot(images);
        });
    };

    const optimizeImages = (images = []) => {
        return Promise.try(() => {
            traceInfo('client.optimizeImages', {
                imageQuality: cfg.imageQuality,
                imageSize: cfg.imageSize,
                imageCount: images.length
            });

            return images;
        })

        // hooks: beforeOptimize
        .tap(() => {
            return hooks.beforeOptimize(images);
        })

        // Optimize image
        .map(({image, rect}) => {
            const imageType = cfg.out.imageType;
            const imageQuality = cfg.imageQuality;

            if(imageType === 'png') {
                const level = Math.floor(10 - imageQuality / 10);

                image = image.png({
                    compressionLevel: Math.max(0, Math.min(9, level)),
                    progressive: false
                });
            }
            else {
                image = image.jpeg({
                    quality: imageQuality,
                    progressive: false
                });
            }

            return { image, rect };
        }, {
            concurrency: cpuCount
        })

        // hooks: afterOptimize
        .tap(images => {
            return hooks.afterOptimize(images);
        });
    };

    const saveImages = (images = []) => {
        const skipImagesShot = cfg.skipImagesShot;

        return Promise.try(() => {
            if(skipImagesShot) {
                return;
            }

            return fsp.ensureDir(cfg.out.path);
        })
        .then(() => {
            return images;
        })
        .map(({image, rect}, idx) => {
            const out = cfg.out;
            const ext = path.extname(out.image);
            const name = path.basename(out.image, ext);
            const outName = name + (idx > 0 ? '-' + (idx + 1) : '');
            const imagePath = path.join(out.path, `${outName}${ext}`);

            return Promise.try(() => {
                if(skipImagesShot) {
                    return;
                }

                traceInfo(`client.saveImage-${idx}`, {
                    imageQuality: cfg.imageQuality,
                    imageSize: cfg.imageSize
                });

                return image.toFile(imagePath);
            })
            .tap(() => {
                if(!skipImagesShot) {
                    return;
                }

                traceInfo(`client.saveImage.done-${idx}`);
            })
            .then(() => {
                return {
                    imagePath,
                    image,
                    rect
                };
            });
        }, {
            concurrency: cpuCount
        })
        // hooks: afterSaveImages
        .tap(images => {
            return hooks.afterSaveImages(images);
        });
    };

    const exportImages = (images = []) => {
        const skipImagesShot = cfg.skipImagesShot;

        return Promise.map(images, ({image, rect}, idx) => {
            const ret = {
                imageBuffer: null,
                image,
                rect
            };

            if(skipImagesShot) {
                return ret;
            }

            traceInfo(`client.exportImage-${idx}`, {
                imageQuality: cfg.imageQuality,
                imageSize: cfg.imageSize
            });

            return Promise.try(() => {
                return image.toBuffer();
            })
            .tap(() => {
                traceInfo(`client.exportImage.done-${idx}`);
            })
            .then(buf => {
                buf.type = `image/${cfg.out.imageType}`;

                ret.imageBuffer = buf;

                return ret;
            });
        }, {
            concurrency: cpuCount
        });
    };

    // hooks
    hooks = lodash.defaults(hooks, {
        beforeCheck: lodash.noop,
        afterCheck: lodash.noop,
        beforeShot: lodash.noop,
        afterShot: lodash.noop,
        beforeOptimize: lodash.noop,
        afterOptimize: lodash.noop,
        afterSaveImages: lodash.noop,
        afterFormatResult: lodash.noop
    });

    return Promise.try(() => {
        traceInfo('start');

        if(!cfg.url) {
            throw new Error('url not provided');
        }

        return bridge.requestClient()
        // Cache client
        .then(clt => {
            client = clt;
        });
    })
    // Load url
    .then(() => {
        traceInfo('page.open', {
            hasContent: !!cfg.content,
            viewport: cfg.viewport
        });

        return client.openPage(cfg.url, {
            viewport: {
                height: cfg.viewport[1],
                width: cfg.viewport[0]
            }
        });
    })
    // Update document content
    .then(() => {
        if(!cfg.htmlContent) {
            return;
        }

        traceInfo('page.updateDocumentContent', {
            contentTemplate: cfg.contentTemplate
        });

        return client.setDocumentContent(cfg.htmlContent);
    })

    // hook: beforeCheck
    .tap(() => {
        traceInfo('page.check');

        return hooks.beforeCheck(client);
    })

    // Check render status
    .then(() => {
        const selector = cfg.wrapSelector;
        const minCount = cfg.wrapMinCount;
        const timeout = +cfg.wrapFindTimeout || 1000;
        const maxTimeout = Math.min(SHOT_WAIT_MAX_TIMEOUT, timeout);
        const errorSelector = cfg.errorSelector;
        const getRenderStatusDataCode = `
            var renderStatusData = {
                errorNodeCount: document.querySelectorAll('${errorSelector}').length,
                wrapNodeCount: document.querySelectorAll('${selector}').length,
                readyState: document.readyState
            };

            JSON.stringify(renderStatusData);
        `;

        return wait((resolve, reject, abort) => {
            return Promise.try(() => {
                return client.evaluate(getRenderStatusDataCode);
            })
            .then(result => {
                return JSON.parse(result.value);
            })
            .then(statusData => {
                const err = new Error(`Elements not found by ${selector}`);

                err.statusData = statusData;
                err.status = 404;

                // Check page load status
                if(statusData.readyState !== 'complete') {
                    err.message = `Page load fialed: ${statusData.readyState}`;

                    throw err;
                }

                // Check render error first
                if(statusData.errorNodeCount) {
                    err.message = `Page render error by ${errorSelector}`;

                    // Force abort
                    abort(err);

                    throw err;
                }

                // Check wrap node count
                if(!statusData.wrapNodeCount || statusData.wrapNodeCount < minCount) {
                    throw err;
                }

                return statusData;
            })
            .then(resolve)
            .catch(reject);
        }, {
            timeout: maxTimeout,
            interval: 100
        })
        .catch(err => {
            const statusData = err.statusData || {};

            traceInfo(`page.check.failed: ${err.message}`, statusData);

            throw err;
        });
    })

    // hook: afterCheck
    .tap(statusData => {
        traceInfo('page.check.done', statusData);

        return hooks.afterCheck(statusData, client);
    })

    // clac rects
    .then(calcRects)

    // delay render
    .delay(Math.min(1000, cfg.renderDelay))

    // shot images by rects
    .then(rects => {
        return shotImages(rects);
    })

    // clean
    .finally(() => {
        if(client) {
            traceInfo('client.release');

            return bridge.releaseClient(client);
        }
    })

    // shot images by rects
    .then(images => {
        return optimizeImages(images);
    })

    // Save images
    .then(images => {
        if(cfg.dataType !== 'image') {
            return saveImages(images);
        }

        return exportImages(images);
    })

    // Format result
    .then(items => {
        traceInfo('client.formatResult');

        const ret = lodash.clone(cfg.out);

        const metadata = ret.metadata || {};
        const crops = metadata.crops = [];
        const images = ret.images = [];

        items.forEach(item => {
            images.push(item.imageBuffer ? item.imageBuffer : item.imagePath);

            crops.push(item.rect);
        });

        return ret;
    }, {
        concurrency: cpuCount
    })

    // hooks: afterFormatResult
    .tap(result => {
        return hooks.afterFormatResult(result);
    })

    // Check clean
    .tap(() => {
        if(!SHOT_CACHE_CHECK_INTERVAL || shotCounts.total % SHOT_CACHE_CHECK_INTERVAL > 0) {
            return;
        }

        // Without return, skip response delay
        clearTimeoutShots()
        .then(removedIds => {
            traceInfo('clearTimeoutShots', {
                removedIds
            });
        })
        .catch(ex => {
            traceInfo('clearTimeoutShots.error', {
                stack: ex.stack || ex.message
            });
        });
    })

    // Count
    .tap(() => {
        shotCounts.success += 1;

        traceInfo('done');
    })

    .catch(err => {
        shotCounts.error += 1;

        traceInfo('error: ' + err.message, {
            stack: err.stack
        });

        throw err;
    });
};

// status counts
makeshot.shotCounts = shotCounts;

module.exports = makeshot;
