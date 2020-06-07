const entries = require('object.entries');
const path = require('path');
const fse = require('fs-extra');

const emitCountMap = new Map();
const compilerHookMap = new WeakMap();

const standardizeFilePaths = file => {
    file.name = file.name.replace(/\\/g, '/');
    file.path = file.path.replace(/\\/g, '/');
    return file;
};

function ManifestPlugin(opts){
    this.opts = Object.assign({
        publicPath: null,
        basePath: '',
        fileName: 'manifest.json',
        transformExtensions: /^(gz|map)$/i,
        writeToFileEmit: false,
        seed: null,
        filter: null,
        map: null,
        generate: null,
        sort: null,
        serialize(manifest){
            return JSON.stringify(manifest, null, 2);
        }
    }, opts || {});
}

ManifestPlugin.getCompilerHooks = compiler => {
    let hooks = compilerHookMap.get(compiler);
    if (hooks === undefined) {
        const SyncWaterfallHook = require('tapable').SyncWaterfallHook;
        hooks = {
            afterEmit: new SyncWaterfallHook(['manifest'])
        };
        compilerHookMap.set(compiler, hooks);
    }
    return hooks;
};

ManifestPlugin.prototype.getFileType = function(str){
    str = str.replace(/\?.*/, '');
    const split = str.split('.');
    let ext = split.pop();
    if (this.opts.transformExtensions.test(ext)) {
        ext = `${split.pop() }.${ ext}`;
    }
    return ext;
};

ManifestPlugin.prototype.apply = function(compiler){ // eslint-disable-line max-lines-per-function
    const moduleAssets = {};
    const htmlPluginDataArr = [];

    const outputFolder = compiler.options.output.path;
    const outputFile = path.resolve(outputFolder, this.opts.fileName);
    const outputName = path.relative(outputFolder, outputFile);

    const htmlWebpackPluginAlterAssetTags = htmlPluginData => {
        htmlPluginDataArr.push(htmlPluginData);
    };
    const moduleAsset = (module, file) => {
        if (module.userRequest) {
            moduleAssets[file] = path.join(
                path.dirname(file),
                path.basename(module.userRequest)
            );
        }
    };

    const emit = (compilation, compileCallback) => { // eslint-disable-line max-lines-per-function
        const emitCount = emitCountMap.get(outputFile) - 1;
        emitCountMap.set(outputFile, emitCount);

        const seed = this.opts.seed || {};

        const publicPath = this.opts.publicPath == null ? compilation.options.output.publicPath : this.opts.publicPath;
        const stats = compilation.getStats().toJson({
        // Disable data generation of everything we don't use
            all: false,
            // Add asset Information
            assets: true,
            // Show cached assets (setting this to `false` only shows emitted files)
            cachedAssets: true
        });

        let files = compilation.chunks.reduce((files, chunk) => chunk.files.reduce((files, path) => {
            let name = chunk.name ? chunk.name : null;

            if (name) {
                name = `${name }.${this.getFileType(path)}`;
            } else {
                // For nameless chunks, just map the files directly.
                name = path;
            }
            /* Webpack 4: .isOnlyInitial()
               Webpack 3: .isInitial()
               Webpack 1/2: .initial */
            let isInitial;
            if (chunk.isOnlyInitial) {
                isInitial = chunk.isOnlyInitial();
            } else if (chunk.isInitial) {
                isInitial = chunk.isInitial();
            } else {
                isInitial = chunk.initial;
            }
            return [...files, {
                path,
                chunk,
                name,
                isInitial,
                isChunk: true,
                isAsset: false,
                isModuleAsset: false
            }];
        }, files), []);

        /* module assets don't show up in assetsByChunkName.
           we're getting them this way; */
        files = stats.assets.reduce((files, asset) => {
            const name = moduleAssets[asset.name];
            if (name) {
                return [...files, {
                    path: asset.name,
                    name,
                    isInitial: false,
                    isChunk: false,
                    isAsset: true,
                    isModuleAsset: true
                }];
            }

            const isEntryAsset = asset.chunks.length > 0;
            if (isEntryAsset) {
                return files;
            }

            return [...files, {
                path: asset.name,
                name: asset.name,
                isInitial: false,
                isChunk: false,
                isAsset: true,
                isModuleAsset: false
            }];
        }, files);

        files = files.filter(file => {
            // Don't add hot updates to manifest
            const isUpdateChunk = file.path.indexOf('hot-update') >= 0;
            // Don't add manifest from another instance
            const isManifest = emitCountMap.get(path.join(outputFolder, file.name)) !== undefined;

            return !isUpdateChunk && !isManifest;
        });

        /* Append optional basepath onto all references.
           This allows output path to be reflected in the manifest. */
        if (this.opts.basePath) {
            files = files.map(file => {
                file.name = this.opts.basePath + file.name;
                return file;
            });
        }

        if (publicPath) {
            /* Similar to basePath but only affects the value (similar to how
               output.publicPath turns require('foo/bar') into '/public/foo/bar', see
               https://github.com/webpack/docs/wiki/configuration#outputpublicpath */
            files = files.map(file => {
                file.path = publicPath + file.path;
                return file;
            });
        }

        files = files.map(standardizeFilePaths);

        if (this.opts.filter) {
            files = files.filter(this.opts.filter);
        }

        if (this.opts.map) {
            files = files.map(this.opts.map).map(standardizeFilePaths);
        }

        if (this.opts.sort) {
            files = files.sort(this.opts.sort);
        }

        for (const {body, head, outputName} of htmlPluginDataArr) {
            const onReduce = (html, {tagName, attributes}) => {
                let fragment = `<${tagName}${Object.entries(attributes).reduce((attrs, [key, value]) => {
                    if (/src|href/i.test(key)) {
                        value = `${publicPath || ''}${value.substr((compilation.options.output.publicPath || '').length)}`;
                    }
                    return `${attrs} ${key}="${value}"`;
                }, '')}>`;
                if (/script/i.test(tagName)) {
                    fragment += `</${tagName}>`;
                }
                return `${html}${html.length > 0 ? '\n' : ''}${fragment}`;
            };
            seed[outputName] = {
                head: head.reduce(onReduce, ''),
                body: body.reduce(onReduce, '')
            };
        }

        let manifest;
        if (this.opts.generate) {
            const entrypointsArray = Array.from(
                compilation.entrypoints instanceof Map ?
                // Webpack 4+
                    compilation.entrypoints.entries() :
                // Webpack 3
                    entries(compilation.entrypoints)
            );
            const entrypoints = entrypointsArray.reduce(
                (e, [name, entrypoint]) => Object.assign(e, {[name]: entrypoint.getFiles()}),
                {}
            );
            manifest = this.opts.generate(seed, files, entrypoints);
        } else {
            manifest = files.reduce((manifest, file) => {
                manifest[file.name] = file.path;
                return manifest;
            }, seed);
        }

        let waitUtil = Promise.resolve();
        const isLastEmit = emitCount === 0;
        if (isLastEmit) {
            const output = this.opts.serialize(manifest);

            compilation.assets[outputName] = {
                source(){
                    return output;
                },
                size(){
                    return output.length;
                }
            };

            if (this.opts.writeToFileEmit) {
                waitUtil = fse.outputFile(outputFile, output);
            }
        }

        if (compiler.hooks) {
            ManifestPlugin.getCompilerHooks(compiler).afterEmit.call(manifest);
        } else {
            compilation.applyPluginsAsync('webpack-manifest-plugin-after-emit', manifest, compileCallback);
        }
        return waitUtil.then(() => {
            compileCallback();
        });
    };

    function beforeRun(compiler, callback){
        const emitCount = emitCountMap.get(outputFile) || 0;
        emitCountMap.set(outputFile, emitCount + 1);

        if (callback) {
            return callback();
        }
        return null;
    }

    if (compiler.hooks) {
        const pluginOptions = {
            name: 'ManifestPlugin',
            stage: Infinity
        };

        /* Preserve exposure of custom hook in Webpack 4 for back compatability.
           Going forward, plugins should call `ManifestPlugin.getCompilerHooks(compiler)` directy. */
        if (!Object.isFrozen(compiler.hooks)) {
            compiler.hooks.webpackManifestPluginAfterEmit = ManifestPlugin.getCompilerHooks(compiler).afterEmit;
        }

        compiler.hooks.compilation.tap(pluginOptions, compilation => {
            if (typeof compilation.hooks.htmlWebpackPluginAlterAssetTags === 'object') {
                compilation.hooks.htmlWebpackPluginAlterAssetTags.tap(pluginOptions, htmlWebpackPluginAlterAssetTags);
            } else {
                const HtmlWebpackPlugin = require('html-webpack-plugin');
                HtmlWebpackPlugin.getHooks(compilation).alterAssetTagGroups.tap(pluginOptions, ({headTags, bodyTags, ...rest}) => htmlWebpackPluginAlterAssetTags({
                    head: headTags,
                    body: bodyTags,
                    ...rest
                }));
            }
            compilation.hooks.moduleAsset.tap(pluginOptions, moduleAsset);
        });
        compiler.hooks.emit.tapAsync(pluginOptions, emit);

        compiler.hooks.run.tap(pluginOptions, beforeRun);
        compiler.hooks.watchRun.tap(pluginOptions, beforeRun);
    } else {
        compiler.plugin('compilation', compilation => {
            compilation.plugin('html-webpack-plugin-alter-asset-tags', htmlWebpackPluginAlterAssetTags);
            compilation.plugin('module-asset', moduleAsset);
        });
        compiler.plugin('emit', emit);

        compiler.plugin('before-run', beforeRun);
        compiler.plugin('watch-run', beforeRun);
    }
};

module.exports = ManifestPlugin;
