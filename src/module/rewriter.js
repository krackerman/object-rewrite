const assert = require('assert');
const objectScan = require('object-scan');
const objectFields = require('object-fields');
const cmpFn = require('../util/cmp-fn');
const compileTargetMap = require('./rewriter/compile-target-map');

const compileMeta = (plugins, fields) => {
  const pluginsByType = {
    FILTER: [],
    INJECT: [],
    SORT: []
  };

  const inactivePlugins = [...plugins];
  const requiredFields = [...fields];
  const ignoredFields = new Set();

  for (let i = 0; i < requiredFields.length; i += 1) {
    const field = requiredFields[i];
    for (let j = 0; j < inactivePlugins.length; j += 1) {
      const plugin = inactivePlugins[j];
      if (
        plugin.targets.includes(field)
        || (
          (plugin.type !== 'INJECT' || plugin.targetRel === '*')
          && (`${field}.` === plugin.target || field.startsWith(plugin.target))
        )) {
        requiredFields.push(...plugin.requires);
        inactivePlugins.splice(j, 1);
        j -= 1;
        pluginsByType[plugin.type].push(plugin);
        if (plugin.type === 'INJECT') {
          plugin.targets.forEach((target) => {
            if (!plugin.requires.includes(target)) {
              ignoredFields.add(target);
            }
          });
        }
      }
    }
  }

  return {
    filterCbs: compileTargetMap('FILTER', pluginsByType.FILTER),
    injectCbs: compileTargetMap('INJECT', pluginsByType.INJECT),
    sortCbs: compileTargetMap('SORT', pluginsByType.SORT),
    fieldsToRequest: [...new Set(requiredFields)].filter((e) => !ignoredFields.has(e))
  };
};

module.exports = (pluginMap, dataStoreFields) => {
  assert(pluginMap instanceof Object && !Array.isArray(pluginMap));
  assert(Array.isArray(dataStoreFields) && dataStoreFields.every((e) => typeof e === 'string'));

  const plugins = Object.entries(pluginMap).reduce((prev, [prefix, ps]) => {
    ps.forEach((p) => prev.push(p(prefix)));
    return prev;
  }, []);
  const allowedFields = [...plugins.reduce((p, c) => {
    if (c.type === 'INJECT') {
      c.targets.forEach((t) => p.add(t));
    }
    return p;
  }, new Set(dataStoreFields))];

  return {
    allowedFields,
    init: (fields) => {
      assert(Array.isArray(fields));

      if (!fields.every((f) => allowedFields.includes(f))) {
        throw new Error(`Bad field requested: ${fields.filter((f) => !allowedFields.includes(f)).join(', ')}`);
      }

      const {
        injectCbs,
        filterCbs,
        sortCbs,
        fieldsToRequest
      } = compileMeta(plugins, fields);

      assert(
        fieldsToRequest.every((f) => dataStoreFields.includes(f)),
        `Bad Field Requested: ${fieldsToRequest.filter((f) => !dataStoreFields.includes(f))}`
      );

      const injectRewriter = objectScan(Object.keys(injectCbs), {
        useArraySelector: false,
        joined: false,
        filterFn: ({
          key, value, parents, matchedBy, context
        }) => {
          matchedBy.forEach((m) => {
            const promises = injectCbs[m].fn({
              key, value, parents, context: context.context
            });
            context.promises.push(...promises);
          });
          return true;
        }
      });
      const filterRewriter = objectScan(Object.keys(filterCbs), {
        useArraySelector: false,
        joined: false,
        filterFn: ({
          key, value, parents, matchedBy, context
        }) => {
          const result = matchedBy.some((m) => filterCbs[m].fn({
            key, value, parents, context: context.context
          }) === true);
          if (result === false) {
            const parent = key.length === 1 ? context.input : parents[0];
            if (Array.isArray(parent)) {
              parent.splice(key[key.length - 1], 1);
            } else {
              delete parent[key[key.length - 1]];
            }
          }
          return result;
        }
      });
      const sortRewriter = objectScan(Object.keys(sortCbs), {
        useArraySelector: false,
        joined: false,
        filterFn: ({
          key, value, parents, matchedBy, context
        }) => {
          assert(Array.isArray(parents[0]), 'Sort must be on "Array" type.');
          if (context.lookups[key.length - 1] === undefined) {
            context.lookups[key.length - 1] = new Map();
          }
          const lookup = context.lookups[key.length - 1];
          lookup.set(value, sortCbs[matchedBy[0]].fn({
            key, value, parents, context: context.context
          }));
          if (key[key.length - 1] === 0) {
            parents[0].sort((a, b) => cmpFn(lookup.get(a), lookup.get(b)));
            const limits = sortCbs[matchedBy[0]].plugins
              .filter((p) => p.limit !== undefined)
              .map((p) => p.limit({ context: context.context }))
              .filter((l) => l !== undefined);
            if (limits.length !== 0) {
              assert(limits.every((l) => Number.isInteger(l) && l >= 0));
              parents[0].splice(Math.min(...limits));
            }
            context.lookups.splice(key.length - 1);
          }
          return true;
        }
      });
      const retainResult = objectFields.Retainer(fields);

      const rewriteStart = (input, context) => {
        assert(context instanceof Object && !Array.isArray(context));
        const { promises } = injectRewriter(input, { context, promises: [] });
        return promises;
      };
      const rewriteEnd = (input, context) => {
        filterRewriter(input, { input, context });
        sortRewriter(input, { lookups: [], context });
        retainResult(input);
      };
      return {
        fieldsToRequest,
        rewrite: (input, context = {}) => {
          const promises = rewriteStart(input, context);
          assert(promises.length === 0, 'Please use rewriteAsync() for async logic');
          rewriteEnd(input, context);
        },
        rewriteAsync: async (input, context = {}) => {
          const promises = rewriteStart(input, context);
          await Promise.all(promises.map((p) => p()));
          rewriteEnd(input, context);
        }
      };
    }
  };
};