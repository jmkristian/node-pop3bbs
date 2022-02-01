/** Serve as a BBS that looks like JNOS. */

const AGW = require('./agwapi');
const Config = require('./config').readFile(process.argv[2] || 'config.ini');
const EventEmitter = require('events');
const LDAP = require('ldapjs');
const POP = require('yapople');
const SMTP = require('nodemailer');

const log = Config.logger;
const EOL = '\r'; // Seems to be standard in the BBS world.
const CR = '\r'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);
const EM = 25; // end of medium
const NUL = 0; // abort
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

function getAttributes(entry) {
    var attributes = {};
    try {
        if (entry && entry.attributes) {
            entry.attributes.forEach(function(a) {
                attributes[a.type] = a._vals.map(function(value) {
                    return ((typeof value) == 'string') ? value : value.toString('utf-8');
                });
            });
        }
    } catch(err) {
        log.warn(`%o from getAttributes `, attributes);
    }
    return attributes;
}

/** Command Line Interpreter */
class CLI extends EventEmitter {

    constructor(connection) {
        super();
        this.AX25 = connection;
        this.objectID = this.constructor.name + '#' + ++serialNumber + ' ' + this.AX25.theirCall;
        this.buffer = Buffer.alloc(0);
        this.lookingAt = 0;
        this.lookingFor = 'line';
        this.lookingForLF = false;
        var that = this;
        log.info('AX.25 connection from %s', this.AX25.theirCall);
        this.AX25.on('error', function(err) {
            log.warn(err, 'AX.25 error');
        });
        this.AX25.on('close', function() {
            log.info('AX.25 closed');
            if (this.POP) this.POP.disconnect();
            that.emit('close');
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

    parse(buffer) {
        if (!buffer || buffer.length <= 0) return;
        var buf = Buffer.alloc(this.buffer.length + buffer.length);
        this.buffer.copy(buf, 0);
        buffer.copy(buf, this.buffer.length);
        while (buf && buf.length > 0) {
            var end = 0;
            var next = 0;
            var b = this.lookingAt;
            if (this.lookingForLF && buf[b] == LF) {
                ++b; // skip the LF
            }
            this.lookingForLF = false;
            switch(this.lookingFor) {
            case 'message': // ends with '/EX' or EM or NUL
                for (; b < buf.length; ++b) {
                    if (buf[b] == NUL) {
                        end = -1; // don't call sendMessage
                        next = b + 1;
                        break;
                    }
                    if (buf[b] == CR || buf[b] == LF) {
                        log.trace('CR or LF');
                        if (b + 1 >= buf.length) {
                            break; // wait to see what comes next
                        }
                        if (buf[b] == CR && buf[b + 1] == LF) {
                            log.trace('CRLF');
                            ++b;
                        }
                        if (b + 2 >= buf.length) {
                            break; // wait to see what comes next
                        }
                        log.trace('EOL ' + buf[b + 1]);
                        if (buf[b + 1] == EM && (buf[b + 2] == CR || buf[b + 2] == LF)) {
                            end = b;
                            next = b + 3;
                            this.lookingForLF = (buf[b + 2] == CR);
                            break;
                        } else if (buf[b + 1] == '/'.charCodeAt(0)) {
                            log.trace('EOL /');
                            if (b + 4 >= buf.length) {
                                break; // wait to see what comes next
                            }
                            var found = buf.toString('binary', b + 1, b + 5);
                            log.trace(`EOL %s`, found);
                            if (found == '/EX\r' || found == '/EX\n') {
                                end = b;
                                next = b + 5;
                                this.lookingForLF = (buf[b + 4] == CR);
                                break;
                            }
                        }
                    }
                }
                break;
            default: // a line, terminated by \r or \r\n
                for (; b < buf.length; ++b) {
                    if (buf[b] == CR) {
                        end = b;
                        next = b + 1;
                        this.lookingForLF = true;
                        break;
                    } else if (buf[b] == LF) {
                        end = b;
                        next = b + 1;
                        break;
                    }
                }
            }
            if (next <= 0) {
                this.buffer = buf;
                this.lookingAt = b;
                break; // wait to see what comes next
            }
            this.buffer = Buffer.alloc(buf.length - next);
            buf.copy(this.buffer, 0, next);
            this.lookingAt = 0;
            if (this.lookingFor == 'message') {
                this.lookingFor = null;
                if (end >= 0) {
                    var message = Buffer.alloc(end);
                    buf.copy(message, 0, 0, end);
                    this.sendMessage(message);
                }
            } else {
                var line = buf.toString('utf-8', 0, end);
                this.parseLine(line);
            }
            buf = this.buffer;
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
            log.warn(err);
            this.AX25.write(`${err}${EOL}`);
        }
    }

    qualifyEmailAddress(from) {
        if (from.indexOf('@') >= 0) {
            return from;
        }
        return from + '@' + Config.POP.emailDomain;
    }

    logIn(loginName, next) {
        var uid = loginName.toLowerCase();
        var that = this;
        try {
            var ldap = LDAP.createClient({
                url: Config.LDAP.URL,
            });
            var finish = function(err, userName, password) {
                ldap.unbind();
                next(err, userName, password);
            };
            ['error', 'connectRefused', 'connectError', 'resultError'].forEach(function(event) {
                ldap.on(event, function(info) {
                    log.warn('LDAP< $s %o', event, info);
                    finish(`LDAP ${event} ${info || ""}`);
                });
            });
            log.debug('LDAP> bind');
            ldap.bind(Config.LDAP.bindDN, Config.LDAP.password, function(err) {
                if (err) {
                    log.warn(err, `LDAP< bind`);
                    finish(`LDAP ${err}`);
                } else {
                    var userNameAttribute = Config.LDAP.userIdAttribute;
                    var passwordAttribute = Config.LDAP.passwordAttribute;
                    ldap.search(Config.LDAP.baseDN, {
                        scope: 'sub',
                        filter: `${userNameAttribute}=${uid}`,
                        attributes: [userNameAttribute, passwordAttribute],
                        sizeLimit: 1,
                    }, function(err, results) {
                        if (err) {
                            log.warn(err, `LDAP< search`);
                            finish(`LDAP ${err}`);
                        } else {
                            var firstEntry = null;
                            results.on('error', function(err) {
                                log.warn(err, 'LDAP< searchError %s', err.message);
                                finish(`LDAP error ${err.message}`);
                            });
                            results.on('searchEntry', function(entry) {
                                var attrs = getAttributes(entry);
                                log.debug('LDAP< %o', {
                                    objectName: entry.objectName,
                                    attributes: attrs,
                                });
                                if (!firstEntry) {
                                    firstEntry = entry;
                                    var userName = (attrs[userNameAttribute] &&
                                                    attrs[userNameAttribute][0]) || '';
                                    var password = (attrs[passwordAttribute] &&
                                                    attrs[passwordAttribute][0]) || '';
                                    finish(null, userName, password);
                                }
                            });
                            results.on('end', function(result) {
                                if (!firstEntry) {
                                    log.warn(`LDAP< searchEnd %o`, {
                                        status: result.status,
                                        matchedDN: result.matchedDN,
                                        errorMessage: result.errorMessage || null,
                                        sentEntries: result.sentEntries,
                                        attributes: getAttributes(result),
                                    });
                                    finish(`${loginName} is not in the directory.`);
                                }
                            });
                        }
                    });
                }
            });
        } catch(err) {
            log.warn(err, 'LDAP');
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
        log.debug(`POP> %o`, options);
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
            log.warn(err, 'POP');
            next(`POP threw ${err}`);
        }
    }

    setArea(newArea) {
        var that = this;
        var next = function() {
            that.logIn(newArea, function(err, userName, password) {
                if (err) {
                    that.AX25.write(`${EOL}${err}${EOL}${Prompt}`);
                } else {
                    that.login = {userName: userName, password: password};
                    that.openPOP(function(err) {
                        if (err) {
                            that.AX25.write(`${EOL}${err}${EOL}${Prompt}`);
                        }
                        that.AX25.write(`${EOL}${Prompt}`);
                    });
                }
            });
        }
        if (this.POP) {
            this.POP.quit(function(err) {
                if (err) {
                    that.AX25.write(`${EOL}${err}${EOL}${Prompt}`);
                }
                next();
            });
        } else {
            next();
        }
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
        log.info('execute %s', line);
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
            this.setArea(parts[1]);
            return;
        case 'l':  // list
        case 'la': // list all
        case 'lb': // list bulletins
        case 'lm': // list mine
        case 'list':
            var count = this.popCount;
            that.AX25.write(`Mail area: ${this.login.userName}${EOL}`
                            + `${count} messages  -  ${count} new${EOL}${EOL}`);
            that.POP.list(function(err, sizes) {
                if (err && !sizes) sizes = [];
                var showMessage = function showMessage(m) {
                    if (m > count) {
                        that.AX25.write(`${EOL}${Prompt}`);
                    } else {
                        that.POP.top(m, 0, function(err, message) {
                            if (err) {
                                that.AX25.write(`POP top(${m}, 0) ${err}${EOL}`);
                            } else {
                                log.debug(`POP< %o`, message);
                                that.AX25.write(summarize(m, sizes[m], message) + EOL);
                            }
                            showMessage(m + 1);    
                        });
                    }
                };
                that.AX25.write(summarize(0) + EOL);
                showMessage(1);
            });
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
            this.POP.quit(function(err) {
                if (err) {
                    that.AX25.write(`${err}${EOL}`);
                }
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
        log.debug('readMessages %o', numbers);
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
                log.debug('%o', body);
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
        this.lookingFor = null;
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
            log.info('SMTP> %o, body.length: %d', m, body.length);
            m.text = body.toString('utf-8');
            smtp.sendMail(m, function(err, info) {
                if (err) {
                    that.AX25.write(`${err}${EOL}${Prompt}`);
                } else {
                    log.info(`SMTP< %o`, info);
                    that.AX25.write(`Msg queued${EOL}${Prompt}`);
                }
            });
        } catch(err) {
            log.warn(err, 'SMTP');
            this.AX25.write(`SMTP threw ${err}${EOL}${Prompt}`);
        }
    }
}

var server = new AGW.Server(Config);
server.on('error', function(err) {
    log.warn(err, 'AGW error');
});
server.on('connection', function(c) {
    var cli = new CLI(c);
});
server.listen({callTo: Config.AGWPE.myCallSigns}, function(info) {
    log.info('AGW listening %o', info);
});
