const PARAMETER_REGEXP = /([:*])(\w+)/g;
const WILDCARD_REGEXP = /\*/g;
const REPLACE_VARIABLE_REGEXP = '([^\/]+)';
const REPLACE_WILDCARD = '(?:.*)';
const FOLLOWED_BY_SLASH_REGEXP = '(?:\/$|$)';

function clean(s) {
  if (s instanceof RegExp) return s;
  return s.replace(/\/+$/, '').replace(/^\/+/, '/');
}

function regExpResultToParams(match, names) {
  if (names.length === 0) return null;
  if (!match) return null;
  return match
    .slice(1, match.length)
    .reduce((params, value, index) => {
      if (params === null) params = {};
      params[names[index]] = value;
      return params;
    }, null);
}

function replaceDynamicURLParts(route) {
  var paramNames = [], regexp;

  if (route instanceof RegExp) {
    regexp = route;
  } else {
    regexp = new RegExp(
      clean(route)
      .replace(PARAMETER_REGEXP, function (full, dots, name) {
        paramNames.push(name);
        return REPLACE_VARIABLE_REGEXP;
      })
      .replace(WILDCARD_REGEXP, REPLACE_WILDCARD) + FOLLOWED_BY_SLASH_REGEXP
    );
  }
  return { regexp, paramNames };
}

function getUrlDepth(url) {
  return url.replace(/\/$/, '').split('/').length;
}

function compareUrlDepth(urlA, urlB) {
  return getUrlDepth(urlA) < getUrlDepth(urlB);
}

function findMatchedRoutes(url, routes = []) {
  return routes
    .map(route => {
      var { regexp, paramNames } = replaceDynamicURLParts(route.route);
      var match = url.match(regexp);
      var params = regExpResultToParams(match, paramNames);

      return match ? { match, route, params } : false;
    })
    .filter(m => m);
}

function match(url, routes) {
  return findMatchedRoutes(url, routes)[0] || false;
}

function root(url, routes) {
  var matched = findMatchedRoutes(
    url,
    routes.filter(route => {
      let u = clean(route.route);

      return u !== '' && u !== '*';
    })
  );
  var fallbackURL = clean(url);

  if (matched.length > 0) {
    return matched
      .map(m => clean(url.substr(0, m.match.index)))
      .reduce((root, current) => {
        return current.length < root.length ? current : root;
      }, fallbackURL);
  }
  return fallbackURL;
}

function isPushStateAvailable() {
  return !!(
    typeof window !== 'undefined' &&
    window.history &&
    window.history.pushState
  );
}

function isHashChangeAPIAvailable() {
  return !!(
    typeof window !== 'undefined' &&
    'onhashchange' in window
  );
}

function extractGETParameters(url) {
  var [ onlyURL, ...query ] = url.split(/\?(.*)?$/);

  return { onlyURL, GETParameters: query.join('') };
}

function manageHooks(handler, route) {
  if (route && route.hooks && typeof route.hooks === 'object') {
    if (route.hooks.before) {
      route.hooks.before(() => {
        handler();
        route.hooks.after && route.hooks.after();
      });
    } else if (route.hooks.after) {
      handler();
      route.hooks.after && route.hooks.after();
    }
    return;
  }
  handler();
};

function Navigo(r, useHash) {
  this._routes = [];
  this.root = useHash && r ? r.replace(/\/$/, '/#') : (r || null);
  this._useHash = useHash;
  this._paused = false;
  this._destroyed = false;
  this._lastRouteResolved = null;
  this._notFoundHandler = null;
  this._defaultHandler = null;
  this._usePushState = !useHash && isPushStateAvailable();
  this._listen();
  this.updatePageLinks();
}

Navigo.prototype = {
  helpers: {
    match,
    root,
    clean
  },
  navigate: function (path, absolute) {
    var to;

    path = path || '';
    if (this._usePushState) {
      to = (!absolute ? this._getRoot() + '/' : '') + clean(path);
      to = to.replace(/([^:])(\/{2,})/g, '$1/');
      history[this._paused ? 'replaceState' : 'pushState']({}, '', to);
      this.resolve();
    } else if (typeof window !== 'undefined') {
      window.location.href = window.location.href.replace(/#(.*)$/, '') + '#' + path;
    }
    return this;
  },
  on: function (...args) {
    if (typeof args[0] === 'function') {
      this._defaultHandler = { handler: args[0], hooks: args[1] };
    } else if (args.length >= 2) {
      this._add(args[0], args[1], args[2]);
    } else if (typeof args[0] === 'object') {
      let orderedRoutes = Object.keys(args[0]).sort(compareUrlDepth);

      orderedRoutes.forEach(route => {
        this._add(route, args[0][route]);
      });
    }
    return this;
  },
  notFound: function (handler, hooks) {
    this._notFoundHandler = { handler, hooks: hooks };
  },
  resolve: function (current) {
    var handler, m;
    var url = (current || this._cLoc()).replace(this._getRoot(), '');

    if (this._useHash) {
      url = url.replace(/^\/#/, '/');
    }
    let { onlyURL, GETParameters } = extractGETParameters(url);

    if (
      this._paused ||
      (
        this._lastRouteResolved &&
        onlyURL === this._lastRouteResolved.url &&
        GETParameters === this._lastRouteResolved.query
      )
    ) { return false; }

    m = match(onlyURL, this._routes);

    if (m) {
      this._lastRouteResolved = { url: onlyURL, query: GETParameters };
      handler = m.route.handler;
      manageHooks(() => {
        m.route.route instanceof RegExp ?
          handler(...(m.match.slice(1, m.match.length))) :
          handler(m.params, GETParameters);
      }, m.route);
      return m;
    } else if (this._defaultHandler && (onlyURL === '' || onlyURL === '/')) {
      manageHooks(() => {
        this._lastRouteResolved = { url: onlyURL, query: GETParameters };
        this._defaultHandler.handler(GETParameters);
      }, this._defaultHandler);
      return true;
    } else if (this._notFoundHandler) {
      manageHooks(() => {
        this._notFoundHandler.handler(GETParameters);
      }, this._notFoundHandler);
    }
    return false;
  },
  destroy: function () {
    this._routes = [];
    this._destroyed = true;
    clearTimeout(this._listenningInterval);
    typeof window !== 'undefined' ? window.onpopstate = null : null;
  },
  updatePageLinks: function () {
    var self = this;

    if (typeof document === 'undefined') return;

    this._findLinks().forEach(link => {
      if (!link.hasListenerAttached) {
        link.addEventListener('click', function (e) {
          var location = link.getAttribute('href');

          if (!self._destroyed) {
            e.preventDefault();
            self.navigate(clean(location));
          }
        });
        link.hasListenerAttached = true;
      }
    });
  },
  generate: function (name, data = {}) {
    return this._routes.reduce((result, route) => {
      var key;

      if (route.name === name) {
        result = route.route;
        for (key in data) {
          result = result.replace(':' + key, data[key]);
        }
      }
      return result;
    }, '');
  },
  link: function (path) {
    return this._getRoot() + path;
  },
  pause: function (status) {
    this._paused = status;
  },
  disableIfAPINotAvailable: function () {
    if (!isPushStateAvailable()) {
      this.destroy();
    }
  },
  _add: function (route, handler = null, hooks = null) {
    if (typeof handler === 'object') {
      this._routes.push({ route, handler: handler.uses, name: handler.as, hooks: hooks });
    } else {
      this._routes.push({ route, handler, hooks: hooks });
    }
    return this._add;
  },
  _getRoot: function () {
    if (this.root !== null) return this.root;
    this.root = root(this._cLoc(), this._routes);
    return this.root;
  },
  _listen: function () {
    if (this._usePushState) {
      window.onpopstate = () => {
        this.resolve();
      };
    } else if (isHashChangeAPIAvailable()) {
      window.onhashchange = () => {
        this.resolve();
      };
    } else {
      let cached = this._cLoc(), current, check;

      check = () => {
        current = this._cLoc();
        if (cached !== current) {
          cached = current;
          this.resolve();
        }
        this._listenningInterval = setTimeout(check, 200);
      };
      check();
    }
  },
  _cLoc: function () {
    if (typeof window !== 'undefined') {
      return window.location.href;
    }
    return '';
  },
  _findLinks: function () {
    return [].slice.call(document.querySelectorAll('[data-navigo]'));
  }
};

export default Navigo;
