// Reemplazo de google.script.run / google.script.url fuera de Apps Script.
// Cada google.script.run.X(args) se convierte en POST api/rpc/X al servidor,
// así el HTML original funciona sin cambios.
(function () {
  var base = (function () {
    var p = window.location.pathname;
    return p.charAt(p.length - 1) === '/' ? p : p.substring(0, p.lastIndexOf('/') + 1);
  })();

  function call(fnName, args) {
    return fetch(base + 'api/rpc/' + encodeURIComponent(fnName), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ args: args })
    }).then(function (res) {
      return res.json()
        .catch(function () { return { error: 'HTTP ' + res.status }; })
        .then(function (data) {
          if (res.status === 401 && data && data.login) {
            // Sesión vencida: volver a pasar por el login con Google
            window.location.href = base + 'login';
          }
          if (!res.ok || (data && data.error)) throw new Error((data && data.error) || ('HTTP ' + res.status));
          return data.result;
        });
    });
  }

  function makeRunner(onSuccess, onFailure) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (fn) { return makeRunner(fn, onFailure); };
        if (prop === 'withFailureHandler') return function (fn) { return makeRunner(onSuccess, fn); };
        if (prop === 'withUserObject')     return function () { return makeRunner(onSuccess, onFailure); };
        if (typeof prop !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          call(prop, args).then(
            function (r) { if (onSuccess) onSuccess(r); },
            function (e) { if (onFailure) onFailure(e); else console.error('[' + prop + ']', e); }
          );
        };
      }
    });
  }

  function getLocation(cb) {
    var parameters = {}, parameter = {};
    new URLSearchParams(window.location.search).forEach(function (v, k) {
      (parameters[k] = parameters[k] || []).push(v);
      if (!(k in parameter)) parameter[k] = v;
    });
    cb({ parameters: parameters, parameter: parameter, hash: window.location.hash.replace(/^#/, '') });
  }

  window.google = window.google || {};
  window.google.script = {
    run: makeRunner(null, null),
    url: { getLocation: getLocation }
  };
})();
