import { DEV } from 'esm-env';
import {
	PROPS_IS_IMMUTABLE,
	PROPS_IS_LAZY_INITIAL,
	PROPS_IS_RUNES,
	PROPS_IS_UPDATED
} from '../../../constants.js';
import { get_descriptor, is_function } from '../utils.js';
import { mutable_source, set } from './sources.js';
import { derived } from './deriveds.js';
import { get, inspect_fn, is_signals_recorded } from '../runtime.js';
import { safe_equals, safe_not_equal } from './equality.js';

/**
 * @param {((value?: number) => number)} fn
 * @param {1 | -1} [d]
 * @returns {number}
 */
export function update_prop(fn, d = 1) {
	const value = fn();
	fn(value + d);
	return value;
}

/**
 * @param {((value?: number) => number)} fn
 * @param {1 | -1} [d]
 * @returns {number}
 */
export function update_pre_prop(fn, d = 1) {
	const value = fn() + d;
	fn(value);
	return value;
}

/**
 * The proxy handler for rest props (i.e. `const { x, ...rest } = $props()`).
 * Is passed the full `$$props` object and excludes the named props.
 * @type {ProxyHandler<{ props: Record<string | symbol, unknown>, exclude: Array<string | symbol> }>}}
 */
const rest_props_handler = {
	get(target, key) {
		if (target.exclude.includes(key)) return;
		return target.props[key];
	},
	getOwnPropertyDescriptor(target, key) {
		if (target.exclude.includes(key)) return;
		if (key in target.props) {
			return {
				enumerable: true,
				configurable: true,
				value: target.props[key]
			};
		}
	},
	has(target, key) {
		if (target.exclude.includes(key)) return false;
		return key in target.props;
	},
	ownKeys(target) {
		return Reflect.ownKeys(target.props).filter((key) => !target.exclude.includes(key));
	}
};

/**
 * @param {Record<string, unknown>} props
 * @param {string[]} rest
 * @returns {Record<string, unknown>}
 */
export function rest_props(props, rest) {
	return new Proxy({ props, exclude: rest }, rest_props_handler);
}

/**
 * The proxy handler for spread props. Handles the incoming array of props
 * that looks like `() => { dynamic: props }, { static: prop }, ..` and wraps
 * them so that the whole thing is passed to the component as the `$$props` argument.
 * @template {Record<string | symbol, unknown>} T
 * @type {ProxyHandler<{ props: Array<T | (() => T)> }>}}
 */
const spread_props_handler = {
	get(target, key) {
		let i = target.props.length;
		while (i--) {
			let p = target.props[i];
			if (is_function(p)) p = p();
			if (typeof p === 'object' && p !== null && key in p) return p[key];
		}
	},
	getOwnPropertyDescriptor(target, key) {
		let i = target.props.length;
		while (i--) {
			let p = target.props[i];
			if (is_function(p)) p = p();
			if (typeof p === 'object' && p !== null && key in p) return get_descriptor(p, key);
		}
	},
	has(target, key) {
		for (let p of target.props) {
			if (is_function(p)) p = p();
			if (key in p) return true;
		}

		return false;
	},
	ownKeys(target) {
		/** @type {Array<string | symbol>} */
		const keys = [];

		for (let p of target.props) {
			if (is_function(p)) p = p();
			for (const key in p) {
				if (!keys.includes(key)) keys.push(key);
			}
		}

		return keys;
	}
};

/**
 * @param {Array<Record<string, unknown> | (() => Record<string, unknown>)>} props
 * @returns {any}
 */
export function spread_props(...props) {
	return new Proxy({ props }, spread_props_handler);
}

/**
 * This function is responsible for synchronizing a possibly bound prop with the inner component state.
 * It is used whenever the compiler sees that the component writes to the prop, or when it has a default prop_value.
 * @template V
 * @param {Record<string, unknown>} props
 * @param {string} key
 * @param {number} flags
 * @param {V | (() => V)} [initial]
 * @returns {(() => V | ((arg: V) => V) | ((arg: V, mutation: boolean) => V))}
 */
export function prop(props, key, flags, initial) {
	var immutable = (flags & PROPS_IS_IMMUTABLE) !== 0;
	var runes = (flags & PROPS_IS_RUNES) !== 0;
	var prop_value = /** @type {V} */ (props[key]);
	var setter = get_descriptor(props, key)?.set;

	if (prop_value === undefined && initial !== undefined) {
		if (setter && runes) {
			// TODO consolidate all these random runtime errors
			throw new Error(
				'ERR_SVELTE_BINDING_FALLBACK' +
					(DEV
						? `: Cannot pass undefined to bind:${key} because the property contains a fallback value. Pass a different value than undefined to ${key}.`
						: '')
			);
		}

		// @ts-expect-error would need a cumbersome method overload to type this
		if ((flags & PROPS_IS_LAZY_INITIAL) !== 0) initial = initial();

		prop_value = /** @type {V} */ (initial);

		if (setter) setter(prop_value);
	}

	var getter = () => {
		var value = /** @type {V} */ (props[key]);
		if (value !== undefined) initial = undefined;
		return value === undefined ? /** @type {V} */ (initial) : value;
	};

	// easy mode — prop is never written to
	if ((flags & PROPS_IS_UPDATED) === 0) {
		return getter;
	}

	// intermediate mode — prop is written to, but the parent component had
	// `bind:foo` which means we can just call `$$props.foo = value` directly
	if (setter) {
		return function (/** @type {V} */ value) {
			if (arguments.length === 1) {
				/** @type {Function} */ (setter)(value);
				return value;
			} else {
				return getter();
			}
		};
	}

	// hard mode. this is where it gets ugly — the value in the child should
	// synchronize with the parent, but it should also be possible to temporarily
	// set the value to something else locally.
	var from_child = false;
	var was_from_child = false;

	// The derived returns the current value. The underlying mutable
	// source is written to from various places to persist this value.
	var inner_current_value = mutable_source(prop_value);
	var current_value = derived(() => {
		var parent_value = getter();
		var child_value = get(inner_current_value);

		if (from_child) {
			from_child = false;
			was_from_child = true;
			return child_value;
		}

		was_from_child = false;
		return (inner_current_value.v = parent_value);
	});

	if (!immutable) current_value.equals = safe_equals;

	return function (/** @type {V} */ value) {
		var current = get(current_value);

		// legacy nonsense — need to ensure the source is invalidated when necessary
		// also needed for when handling inspect logic so we can inspect the correct source signal
		if (is_signals_recorded || (DEV && inspect_fn)) {
			// set this so that we don't reset to the parent value if `d`
			// is invalidated because of `invalidate_inner_signals` (rather
			// than because the parent or child value changed)
			from_child = was_from_child;
			// invoke getters so that signals are picked up by `invalidate_inner_signals`
			getter();
			get(inner_current_value);
		}

		if (arguments.length > 0) {
			if (!current_value.equals(value)) {
				from_child = true;
				set(inner_current_value, value);
				get(current_value); // force a synchronisation immediately
			}

			return value;
		}

		return current;
	};
}
