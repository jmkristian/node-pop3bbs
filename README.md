Here is a simple [BBS](https://en.wikipedia.org/wiki/Bulletin_board_system)
backed by standard POP and SMTP email servers.
This could be useful in an intranet, for example
an [AREDN](https://www.arednmesh.org/) network.
If there are standard email servers in the intranet,
this BBS enables users to access them via AX.25 packet radio.
BBS users can exchange email with other users of the mail servers,
who may use email clients like Microsoft Mail or Outlook.

[Outpost](https://www.outpostpm.org/index.php) works with this BBS.
Users connect to the BBS via [AX.25](https://en.wikipedia.org/wiki/AX.25).
The user interface is a subset of [JNOS](https://www.langelaar.net/jnos2/) version 2.
Unlike JNOS, this BBS uses
a POP server to download messages,
an SMTP server to send messages,
an LDAP server to identify users and
an AGWPE-compatible server to handle AX.25 connections,

To run the BBS:
1. Clone this repository.
2. Start a command interpreter (e.g. bash or Windows cmd) in your clone.
3. Check whether node.js is installed, by running the command `npm --version` .
   If not, [install node.js](https://nodejs.org/en/download/).
4. Download node modules, by running the command `npm install` .
   Ignore output about "gyp ERR! find Python"; it seems to be harmless.
5. Copy config-example.ini to config.ini.
6. Edit config.ini to identify:
   * your POP, SMTP, LDAP and AGWPE servers
   * an LDAP user authorized to read users' passwords (bindDN and password)
   * how to find a user's password in the LDAP directory
     (baseDN, userIdAttribute and passwordAttribute)
7. Run the command `node ./bbs.js`

A user's email address is their call sign plus the POP emailDomain in config.ini.

A user may read other mailboxes using the BBS 'AREA' command, but
may not delete mail from them, nor send email while reading them.
This is useful for publishing bulletins to be read by all users.
Outpost can be configured to automatically download these bulletins,
and not download a bulletin repeatedly.

The output from bbs.js is generated using [Bunyan](https://www.npmjs.com/package/bunyan).
You can convert it to a more humane format by piping it through
`./node_modules/.bin/bunyan --output short` .

This software works on Windows and Linux, with
[node.js](https://nodejs.org/en/) version 10.18.1,
[Direwolf](https://github.com/wb2osz/direwolf) version 1.7,
and [UZ7HO SoundModem](http://uz7.ho.ua/packetradio.htm) version 1.13.
It might work with older versions or on Mac, but I haven't tried it.
