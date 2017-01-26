Shota-URL
=========
[Shota-URL](https://s.meru.ml) is an experimental URL shorten service written in JavaScript. It allows users to make shorten URLs that contains more than 1 destination. When the shorten URL is clicked, it can be configured to show optional message, showing multiple links, which allowed open the links in single-click (which requires client to white-list the popup blocking on this service in their browsers), or even play with luckiness: this service will randomize the destination URL and prompt it to clients.

Currently, it only has a traditional Chinese front-end interface, other language is pending.

Requirements
------------
The server side of Shota-URL is run in Node.js environment and MongoDB as storage backend.

Installation
------------
Assume you have installed both Node.js and a running instance of MongoDB.

- First clone this repository:
```bash
$ git clone https://github.com/JLChnToZ/shota-url.git
$ cd shota-url
```
- Then install all dependencies with NPM:
```bash
$ npm install
```
- Next, edit `config.json`, change the IP, port, etc. for your needs.
- Finally, you may directly launch the service by entering `node index.js` directly, or you may run `index.js` with [forever](http://github.com/foreverjs/forever) if you want it to run at background.

Contributing
-----------
Contributions are welcome! Simply clone this repository and modify it and open a pull request, I will review it and merge it if it is suitable. For any other bugs and/or questions, you may file an issue and I will handle it if have time.

License
-------
[MIT](LICENSE)