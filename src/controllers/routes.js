'use strict';

/**
 * Pterodactyl - Daemon
 * Copyright (c) 2015 - 2016 Dane Everitt <dane@daneeveritt.com>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const rfr = require('rfr');
const Async = require('async');
const Request = require('request');
const Util = require('util');
const Fs = require('fs-extra');
const Mime = require('mime');
const Path = require('path');
const Crypto = require('crypto');
const _ = require('lodash');

const ConfigHelper = rfr('src/helpers/config.js');
const ResponseHelper = rfr('src/helpers/responses.js');
const BuilderController = rfr('src/controllers/builder.js');
const DeleteController = rfr('src/controllers/delete.js');
const Log = rfr('src/helpers/logger.js');

const Config = new ConfigHelper();
let Responses;
let Auth;

class RouteController {
    constructor(auth, req, res) {
        this.req = req;
        this.res = res;
        Auth = auth;
        Responses = new ResponseHelper(req, res);
    }

    // Returns Index
    getIndex() {
        this.res.send('Pterodactyl Management Daemon');
    }

    // Saves Daemon Configuration to Disk
    putConfig() {
        if (!Auth.allowed('c:config')) return;
        Config.save(this.req.params, function (err) {
            if (err) return this.res.send(500, { 'error': err.message });
            return this.res.send(204);
        });
    }

    postNewServer() {
        if (!Auth.allowed('c:create')) return;
        const Builder = new BuilderController(this.req.params);
        this.res.send(202, { 'message': 'Server is being built now, this might take some time if the docker image doesn\'t exist on the system yet.' });

        // We sent a HTTP 202 since this might take awhile.
        // We do need to monitor for errors and negatiate with
        // the panel if they do occur.
        Builder.init(function (err, data) {
            if (err) Log.error(err);

            const HMAC = Crypto.createHmac('sha256', Config.get('keys.0'));
            HMAC.update(data.uuid);

            Request.post(Config.get('remote.installed'), {
                form: {
                    server: data.uuid,
                    signed: HMAC.digest('base64'),
                    installed: (err) ? 'error' : 'installed',
                },
                followAllRedirects: true,
                timeout: 5000,
            }, function (requestErr, response, body) {
                if (requestErr || response.statusCode !== 200) {
                    Log.warn(requestErr, 'An error occured while attempting to alert the panel of server install status.', { code: (typeof response !== 'undefined') ? response.statusCode : null, responseBody: body });
                } else {
                    Log.info('Notified remote panel of server install status.');
                }
            });
        });
    }

    getAllServers() {
        if (!Auth.allowed('c:list')) return;
        const responseData = {};
        const self = this;
        Async.each(Auth.allServers(), function (server, callback) {
            responseData[server.json.uuid] = {
                container: server.json.container,
                service: server.json.service,
                status: server.status,
                query: server.processData.query,
                proc: server.processData.process,
            };
            callback();
        }, function () {
            return self.res.send(responseData);
        });
    }

    deleteServer() {
        if (!Auth.allowed('g:server:delete')) return;
        const Delete = new DeleteController(Auth.server().json);
        Delete.delete(function (err) {
            return Responses.generic204(err);
        });
    }

    // Handles server power
    putServerPower() {
        const self = this;
        if (this.req.params.action === 'start') {
            if (!Auth.allowed('s:power:start')) return;
            Auth.server().start(function (err) {
                if (err && _.includes(err.message, 'Server is currently queued for a container rebuild')) {
                    return self.res.send(202, { 'message': err.message });
                }
                Responses.generic204(err);
            });
        } else if (this.req.params.action === 'stop') {
            if (!Auth.allowed('s:power:stop')) return;
            Auth.server().stop(function (err) {
                return Responses.generic204(err);
            });
        } else if (this.req.params.action === 'restart') {
            if (!Auth.allowed('s:power:restart')) return;
            Auth.server().restart(function (err) {
                if (err && _.includes(err.message, 'Server is currently queued for a container rebuild')) {
                    return self.res.send(202, { 'message': err.message });
                }
                Responses.generic204(err);
            });
        } else if (this.req.params.action === 'kill') {
            if (!Auth.allowed('s:power:kill')) return;
            Auth.server().kill(function (err) {
                return Responses.generic204(err);
            });
        } else {
            this.res.send(404, { 'error': 'Unknown power action recieved.' });
        }
    }

    getServer() {
        if (!Auth.allowed('s:get')) return;
        this.res.send({
            container: Auth.server().json.container,
            service: Auth.server().json.service,
            status: Auth.server().status,
            query: Auth.server().processData.query,
            proc: Auth.server().processData.process,
        });
    }

    // Sends command to server
    postServerCommand() {
        if (!Auth.allowed('s:command')) return;
        if (!_.isUndefined(this.req.params.command)) {
            if (this.req.params.command.trim().replace(/^\/*/, '').startsWith(Auth.server().service.object.stop)) {
                if (!Auth.allowed('s:power:stop')) return;
            }
            Auth.server().command(this.req.params.command, function (err) {
                return Responses.generic204(err);
            });
        } else {
            this.res.send(500, { 'error': 'Missing command in request.' });
        }
    }

    // Returns listing of server files.
    getServerDirectory() {
        const self = this;
        if (!Auth.allowed('s:files:get')) return;
        if (!this.req.params[0]) this.req.params[0] = '.';
        Auth.server().fs.directory(this.req.params[0], function getServerDirectoryListDirectory(err, data) {
            if (err) {
                return Responses.generic500(err);
            }
            return self.res.send(data);
        });
    }

    // Return file contents
    getServerFile() {
        const self = this;
        if (!Auth.allowed('s:files:read')) return;
        Auth.server().fs.read(this.req.params[0], function getServerFileRead(err, data) {
            if (err) {
                return Responses.generic500(err);
            }
            return self.res.send({ content: data });
        });
    }

    getServerLog() {
        const self = this;
        if (!Auth.allowed('s:console')) return;
        Auth.server().fs.readEnd(Auth.server().service.object.log.location, function getServerLogReadEnd(err, data) {
            if (err) {
                return Responses.generic500(err);
            }
            return self.res.send(data);
        });
    }

    postServerFile() {
        if (!Auth.allowed('s:files:post')) return;
        Auth.server().fs.write(this.req.params[0], this.req.params.content, function postServerFileWrite(err) {
            return Responses.generic204(err);
        });
    }

    deleteServerFile() {
        if (!Auth.allowed('s:files:delete')) return;
        Auth.server().fs.delete(this.req.params[0], function deleteServerFileDelete(err) {
            return Responses.generic204(err);
        });
    }

    updateServerConfig() {
        if (!Auth.allowed('g:server:patch')) return;
        Auth.server().modifyConfig(this.req.params, (this.req.method === 'PUT'), function updateServerConfigModifyConfig(err) {
            return Responses.generic204(err);
        });
    }

    rebuildServer() {
        if (!Auth.allowed('g:server:rebuild')) return;
        Auth.server().modifyConfig({ rebuild: true }, false, function rebuildServerModifyConfig(err) {
            Auth.server().log.info('Server has been queued for a container rebuild on next boot.');
            return Responses.generic204(err);
        });
    }

    setSFTPPassword() {
        if (!Auth.allowed('s:set-password')) return;
        Auth.server().setPassword(this.req.params.password, function (err) {
            return Responses.generic204(err);
        });
    }

    postServerSuspend() {
        if (!Auth.allowed('g:server:suspend')) return;
        Auth.server().suspend(function (err) {
            return Responses.generic204(err);
        });
    }

    postServerUnsuspend() {
        if (!Auth.allowed('g:server:unsuspend')) return;
        Auth.server().unsuspend(function (err) {
            return Responses.generic204(err);
        });
    }

    downloadServerFile() {
        if (!Config.get('remote.download')) {
            return this.res.send(501, { 'error': 'This action has not been properly configured on the daemon.' });
        }

        const self = this;
        Request.post(Config.get('remote.download'), {
            form: {
                token: this.req.params[0],
            },
            timeout: 5000,
        }, function (err, response, body) {
            if (err) {
                Log.warn(err, 'Download action failed due to an error with the request.');
                return self.res.send(500, { 'error': 'An error occured while attempting to perform this request.' });
            }

            if (response.statusCode === 200) {
                try {
                    const json = JSON.parse(body);
                    if (typeof json !== 'undefined' && json.path) {
                        const Server = Auth.allServers();
                        // Does the server even exist?
                        if (_.isUndefined(Server[json.server])) {
                            return self.res.send(404, { 'error': 'No server found for the specified resource.' });
                        }

                        // Get necessary information for the download.
                        const Filename = Path.basename(json.path);
                        const Mimetype = Mime.lookup(json.path);
                        const File = Server[json.server].path(json.path);
                        const Stat = Fs.statSync(File);
                        self.res.writeHead(200, {
                            'Content-Type': Mimetype,
                            'Content-Length': Stat.size,
                            'Content-Disposition': Util.format('attachment; filename=%s', Filename),
                        });
                        const Filestream = Fs.createReadStream(File);
                        Filestream.pipe(self.res);
                    } else {
                        return self.res.send(424, { 'error': 'The upstream response did not include a valid download path.' });
                    }
                } catch (ex) {
                    Log.error(ex);
                    return self.res.send(500, { 'error': 'An unexpected error occured while attempting to process this request.' });
                }
            } else {
                return self.res.send(502, { 'error': 'An error occured while attempting to authenticate with an upstream provider.', res_code: response.statusCode });
            }
        });
    }
}

module.exports = RouteController;
