/** Serve as a BBS that looks like JNOS. */

const AGW = require('./agwapi');
const Config = require('./config').readFile(process.argv[2] || 'config.ini');
const EventEmitter = require('events');
const LDAP = require('ldapjs-promise');
const POP = require('yapople');
const SMTP = require('nodemailer');

const log = Config.logger;
const EOL = '\r'; // Seems to be standard in the BBS world.
const CR = '\r'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);
const CtrlA = 0;
const endOfLineMarkers = ['\r\n', '\r', '\n'].map(Buffer.from);
const endOfMessageMarkers = [
    '/EX',
    '\x19', // ^Z EM end of medium
    '\x00', // ^A NUL
].map(Buffer.from);
const MonthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
];

const Prompt = `(#1) >${EOL}`;

var serialNumber = 0;

function column(width, data) {
    switch(typeof data) {
    // case 'undefined':
    case 'null':
        return ' '.repeat(width);
    case 'string':
        if (data.length > width) {
            return data.slice(0, width);
        } else {
            return data + ' '.repeat(width - data.length);
        }
    default:
        data = '' + data;
        if (data.length > width) {
            return data.slice(data.length - width);
        } else {
            return ' '.repeat(width - data.length) + data;
        }
    }
}

function getAddressList(message, field) {
    var from = message[field.toLowerCase()];
    if (!(from && from.length)) return '';
    return from.map(function(item) {
        return item.address || item.name;
    }).join('; ');
}

function getAddressHeader(message, field) {
    var list = getAddressList(message, field);
    return list ? `${field}: ${list}${EOL}` : '';
}

function summarize(number, size, message) {
    if (number == 0) {
        return 'St.  #  TO            FROM     DATE   SIZE SUBJECT';
    }
    try {
        var date = message.date
            ? (column(3, MonthNames[message.date.getMonth()])
               + column(3, message.date.getDate()))
            : '';
        return '  N' + column(4, number)
            + ' ' + column(13, getAddressList(message, 'To') || '')
            + ' ' + column(8, getAddressList(message, 'From') || '')
            + ' ' + column(6, date)
            + ' ' + column(4, (size != null) ? size : message.text ? message.text.length : '')
            + ' ' + column(36, message.subject || '');
    } catch(err) {
        return '  N' + column(5, number) + ' ' + err;
    }
}

/** Command Line Interpreter */
class CLI {

    constructor(connection) {
        this.AX25 = connection;
        this.buffer = Buffer.alloc(0);
        this.log = log.child({
            CLI: ++serialNumber,
            caller: this.AX25.theirCall,
        });
        this.log.info('AX.25 connection');
        var that = this;
        this.AX25.on('error', function(err) {
            that.log.warn(err, 'AX.25 error');
        });
        this.AX25.on('close', function() {
            that.log.info('AX.25 closed');
            if (this.POP) this.POP.disconnect();
        });
        this.AX25.on('data', function(buffer) {
            try {
                that.parse(buffer);
            } catch(err) {
                that.AX25.write('' + err + `${EOL}${Prompt}`);
            }
        });
        this.AX25.write(`[JNOS-2.0POP-B1FHIM$]${EOL}`);
        if (!/[a-z]+\d[a-z]+/.test(this.AX25.theirCall.toLowerCase())) {
            that.AX25.end(`"${that.AX25.theirCall}" isn't a call sign.${EOL}`);
        } else {
            this.logIn(this.AX25.theirCall, function(err, userName, password) {
                if (err) {
                    that.AX25.write(`${err}${EOL}${Prompt}`);
                } else {
                    that.login = {userName: userName, password: password};
                    that.openPOP(function(err) {
                        if (err) {
                            that.AX25.write(`${err}`);
                        }
                        that.AX25.write(`${EOL}${Prompt}`);
                    });
                }
            });
        }
    }

    /** If buf[end - 1] is the last byte of one of the markers,
        return the index of the first byte of that marker;
        otherwise return -1. The markers must be ASCII.
    */
    findBefore(end, buf, markers) {
        var found = markers.find(function(marker) {
            return (end >= marker.length)
                && (buf.subarray(end - marker.length, end).equals(marker));
        });
        if (!found) return -1;
        // this.log.trace('found %j at %d', found.toString('binary'), end - found.length);
        return end - found.length;
    }

    parse(buffer) {
        if (!buffer || buffer.length <= 0) return;
        // this.log.trace('parse %o %s', this.lookingFor, AGW.toDataSummary(buffer));
        // Concatenate this.buffer + buffer:
        var next = this.buffer.length;
        var buf = Buffer.alloc(next + buffer.length);
        this.buffer.copy(buf, 0);
        buffer.copy(buf, next);
        var start = 0;
        while (start < buf.length) {
            if (this.skipLF && buf[next] == LF) {
                ++next; // skip the LF
                if (start == next - 1) {
                    start = next;
                }
            }
            for (; next < buf.length; ++next) {
                if (buf[next] == CR || buf[next] == LF) {
                    break;
                }
            }
            if (next >= buf.length) { // nothing found
                break;
            }
            // buf[next] is a line break.
            this.skipLF = (buf[next] == CR);
            var end = next++;
            switch(this.lookingFor) {
            case 'message':
                // Was the line break preceded by an end-of-message marker?
                end = this.findBefore(end, buf, endOfMessageMarkers);
                var aborted = (buf[end] == CtrlA);
                if (end > start) {
                    // Was the end-of-message marker preceded by a line break?
                    end = this.findBefore(end, buf, endOfLineMarkers);
                    if (end >= start) { // We found a message.
                        var messageBody = Buffer.alloc(end - start);
                        buf.copy(messageBody, 0, start, end);
                        // this.log.trace('found message body %j', AGW.toDataSummary(messageBody));
                        if (!aborted) {
                            this.sendMessage(messageBody);
                        }
                        this.lookingFor = null;
                        start = next;
                    }
                }
                break;
            default: // We found a line.
                var line = buf.toString('utf-8', start, end);
                this.parseLine(line);
                start = next;
            }
        }
        // Store the remainder of buf and wait for more data.
        if (start == 0) {
            this.buffer = buf;
        } else {
            this.buffer = Buffer.alloc(buf.length - start);
            buf.copy(this.buffer, 0, start);
        }
    }

    parseLine(line) {
        try {
            if (!this.message) {
                this.executeCommand(line);
            } else if (this.message.cc == '') {
                this.message.cc = line.trim() || null;
                this.AX25.write(`Subject:${EOL}`);
            } else if (!this.message.subject) {
                this.message.subject = line;
                this.AX25.write('Enter message.'
                                + '  End with /EX or ^Z in first columnn'
                                + ` (^A aborts):${EOL}`);
                this.lookingFor = 'message';
            }
        } catch(err) {
            this.log.warn(err);
            this.AX25.write(`${err}${EOL}`);
        }
    }

    qualifyEmailAddress(from) {
        if (from.indexOf('@') >= 0) {
            return from;
        }
        return from + '@' + Config.POP.emailDomain;
    }

    logIn(areaName, next) {
        var area = areaName.toLowerCase();
        var that = this;
        try {
            var areaNameAttribute = Config.LDAP.callSignAttribute || Config.LDAP.userIdAttribute;
            var userNameAttribute = Config.LDAP.userIdAttribute;
            var passwordAttribute = Config.LDAP.passwordAttribute;
            var ldap = LDAP.createClient({
                url: Config.LDAP.URL,
            });
            var finish = function(err, userName, password) {
                ldap.unbind();
                next(err, userName, password);
            };
            this.log.debug('LDAP> bind %s', Config.LDAP.bindDN);
            ldap.bind(
                Config.LDAP.bindDN, Config.LDAP.password
            ).then(function() {
                var options = {
                    scope: 'sub',
                    filter: `${areaNameAttribute}=${area}`,
                    attributes: [userNameAttribute, passwordAttribute],
                    sizeLimit: 1,
                };
                that.log.debug('LDAP> search %o', options);
                return ldap.searchReturnAll(Config.LDAP.baseDN, options);
            }).then(function(results) {
                that.log.debug('LDAP< %o', results);
                if (results.entries && results.entries.length > 0) {
                    var entry = results.entries[0];
                    finish(null, entry[userNameAttribute], entry[passwordAttribute]);
                } else {
                    finish(`${areaName} isn't in the directory.`);
                }
            }).catch(function (err) {
                that.log.warn(err, 'LDAP');
                finish(`LDAP ${err}`);
            });
        } catch(err) {
            this.log.warn(err, 'LDAP');
            next(`LDAP ${err}`);
        }
    }

    openPOP(next) {
        var options = {
            host: Config.POP.host,
            port: Config.POP.port,
            tls: false,
            username: this.login.userName,
            password: this.login.password,
            mailparser: true,
        };
        this.log.debug(`POP> %o`, options);
        try {
            var that = this;
            this.POP = new POP.Client(options);
            this.POP.connect(function(err) {
                if (err) {
                    next(`POP connect: ${err}`);
                } else {
                    that.POP.count(function(err, count) {
                        if (err) {
                            next(`POP count: ${err}`);
                        } else {
                            that.popCount = count;
                            that.AX25.write(
                                ((count <= 0) ? 'You have 0 messages.'
                                 : (count == 1) ? 'You have 1 message  -  1 new.'
                                 : `You have ${count} messages  -  ${count} new.`)
                                    + `${EOL}`);
                            next();
                        }
                    });
                }
            });
        } catch(err) {
            this.log.warn(err, 'POP');
            next(`POP threw ${err}`);
        }
    }

    closePOP(next) {
        if (this.POP) {
            this.POP.quit(function(err) {
                if (err) {
                    that.AX25.write(`${err}${EOL}`);
                }
                next();
            });
        } else {
            next();
        }
    }

    listMessages() {
        var that = this;
        var finish = function(err) {
            if (err) {
                that.log.warn(err, 'POP');
                that.AX25.write(`POP ${err}${EOL}`);
            }
            that.AX25.write(`${EOL}${Prompt}`);
        }
        try {
            var count = this.popCount;
            var that = this;
            this.AX25.write(`Mail area: ${this.login.userName}${EOL}`
                            + `${count} messages  -  ${count} new${EOL}${EOL}`);
            this.POP.list(function(err, sizes) {
                if (err) {
                    finish(err);
                    return;
                }
                if (!sizes) sizes = [];
                var showMessage = function showMessage(m) {
                    if (m > count) {
                        finish();
                    } else {
                        that.POP.top(m, 0, function(err, message) {
                            if (err) {
                                that.AX25.write(`POP top(${m}, 0) ${err}${EOL}`);
                            } else {
                                that.log.debug(`POP< %o`, message);
                                that.AX25.write(summarize(m, sizes[m], message) + EOL);
                            }
                            showMessage(m + 1);    
                        });
                    }
                };
                that.AX25.write(summarize(0) + EOL);
                showMessage(1);
            });
        } catch(err) {
            finish(err);
        }
    }

    setArea(newArea) {
        var that = this;
        this.logIn(newArea, function(err, userName, password) {
            if (err) {
                that.AX25.write(`${EOL}${err}${EOL}${Prompt}`);
            } else {
                that.login = {userName: userName, password: password};
                that.openPOP(function(err) {
                    if (err) {
                        that.AX25.write(`${EOL}${err}${EOL}`);
                    }
                    that.AX25.write(`${Prompt}`);
                });
            }
        });
    }

    isMyArea() {
        if ((this.login.userName && this.login.userName.toLowerCase())
            != this.AX25.theirCall.toLowerCase()) {
            this.AX25.write(`Permission denied.`);
            return false;
        }
        return true;
    }

    executeCommand(line) {
        this.log.info('execute %s', line);
        var that = this;
        var parts = line.split(/\s+/);
        switch(parts[0].toLowerCase()) {
        case 'xm':
            if (parts[1] != '0') {
                this.AX25.write(`XM 0${EOL}`);
            }
            break;
        case 'a':
        case 'area':
            this.closePOP(function() {
                that.setArea(parts[1]);
            });
            return;
        case 'l':  // list
        case 'la': // list all
        case 'lb': // list bulletins
        case 'lm': // list mine
        case 'list':
            this.listMessages();
            return;
        case 'r':
        case 'read':
            this.readMessages(parts.slice(1));
            return;
        case 'k':
        case 'kill':
            if (!this.isMyArea()) break;
            this.killMessage(parseInt(parts[1]));
            return;
        case 'sb': // send bulletin
            if (!this.isMyArea()) break;
            this.message = {
                to: line.replace(/^[^\s]*\s+/, ''),
                headers: {'X-BBS-Msg-Type': 'B'},
            };
            this.AX25.write(`Subject:${EOL}`);
            return;
        case 'sp': // send private
            if (!this.isMyArea()) break;
            this.message = {
                to: line.replace(/^[^\s]*\s+/, ''),
            };
            this.AX25.write(`Subject:${EOL}`);
            return;
        case 'sc': // send with CC
            if (!this.isMyArea()) break;
            this.message = {
                to: line.replace(/^[^\s]*\s+/, ''),
                cc: '',
            };
            this.AX25.write(`CC:${EOL}`);
            return;
        case 'throw':
            throw 'threw ' + line;
        case 'b':
        case 'bye':
            this.closePOP(function() {
                that.AX25.end(`Goodbye.${EOL}`);
            });
            return;
        default:
            this.AX25.write(line + `?`);
        }
        this.AX25.write(`${EOL}${Prompt}`);
    }

    readMessages(strings) {
        var numbers = [];
        strings.forEach(function(s) {
            numbers.push(parseInt(s));
            // I tried doing this with Array.map, and failed.
        });
        this.log.debug('readMessages %o', numbers);
        var that = this;
        this.POP.retrieve(numbers, function(err, messages) {
            if (err) throw err;
            messages.map(function(message, number) {
                var headers = `Message #` + number + EOL;
                if (message.headers.date) {
                    headers += 'Date: ' + message.headers.date + EOL;
                } else {
                    // Outpost will discard a message that has no Date header.
                    // To prevent this, give it a fake date:
                    headers += 'Date: Mon, 1 Jan 1970 00:00:00 +0000' + EOL;
                }
                headers += getAddressHeader(message, 'From')
                    + getAddressHeader(message, 'To')
                    + getAddressHeader(message, 'Cc')
                    + 'Subject: ' + (message.subject || '') + EOL;
                /* Outpost can't handle MIME headers.
                   ['content-type', 'content-transfer-encoding'].map(function(name) {
                   if (message.headers[name]) {
                   headers += name + ': ' + message.headers[name] + EOL;
                   }
                   });
                */
                var body = (message.text || message.html || '')
                    .replace(/\r?\n/g, EOL) // BBS-style line endings
                /* Sadly, Outpost will ignore lines in the body similar to Prompt.
                   It would be nice to work around this. This doesn't work:
                   // Append a space to any line in the message similar to Prompt:
                   .replace(/^(\(#\d+\) >)\r/, '$1 \r')
                   .replace(/(\r\(#\d+\) >)\r/g, '$1 \r')
                */
                ;
                that.log.debug('%o', body);
                that.AX25.write(headers + EOL + body + (body.endsWith(EOL) ? '' : EOL));
            });
            that.AX25.write(Prompt);
        });
    }

    killMessage(number) {
        var that = this;
        this.POP.delete(number, function(err, messages) {
            if (err) {
                that.AX25.write(`POP ${err}`);
            } else {
                that.AX25.write(`Msg ${number} killed.`);
            }
            that.AX25.write(`${EOL}${Prompt}`);
        });
    }

    sendMessage(body) {
        var myAddress = this.qualifyEmailAddress(this.login.userName);
        var message = this.message;
        this.message = null;
        try {
            var smtp = SMTP.createTransport({
                host: Config.SMTP.host,
                port: Config.SMTP.port,
                secure: false,
                auth: {
                    user: myAddress,
                    pass: this.login.password,
                },
            }, {
                from: myAddress,
            });
            var that = this;
            var expand = function expandAddresses(list) {
                return list.trim().split(/\s*[;,]\s*/).map(function(item) {
                    return that.qualifyEmailAddress(item);
                });
            };
            var m = {
                to: expand(message.to),
                subject: message.subject,
            };
            if (message.cc) {
                m.cc = expand(message.cc);
            }
            if (message.headers) {
                m.headers = message.headers;
            }
            this.log.info('SMTP> %o, body.length: %d', m, body.length);
            m.text = body.toString('utf-8');
            smtp.sendMail(m, function(err, info) {
                if (err) {
                    that.AX25.write(`${err}${EOL}${Prompt}`);
                } else {
                    that.log.info(`SMTP< %o`, info);
                    that.AX25.write(`Msg queued${EOL}${Prompt}`);
                }
            });
        } catch(err) {
            this.log.warn(err, 'SMTP');
            this.AX25.write(`SMTP threw ${err}${EOL}${Prompt}`);
        }
    }
}

var server = new AGW.Server(Config);
server.on('error', function(err) {
    this.log.warn(err, 'AGW error');
});
server.on('connection', function(c) {
    var cli = new CLI(c);
});
server.listen({callTo: Config.AGWPE.myCallSigns}, function(info) {
    this.log.info('AGW listening %o', info);
});
