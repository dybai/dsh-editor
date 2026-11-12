/**
 * @dybai/dsh-editor — Host half.
 *
 * Provides the `dshEditor` workspace + preferences service that the browser
 * editor calls through its Typert Remote namespace. The service is registered
 * with `ctx.provide` in source mode: a visible `typertRemote` binding plus a
 * Remote marker on the prototype make the Typert Gateway's conservative SRC
 * discovery claim `dshEditor/writeFile`, `dshEditor/getModePreferences`,
 * `dshEditor/setModePreferences`, `dshEditor/getKeymap` and
 * `dshEditor/setKeymap`, so no generated Typert artifacts are needed.
 *
 * Deliberately imports no `@deepseek-ai/*` package: every capability comes
 * from the Cordis context (`fs`, `sandboxPolicy`, `sessions`, `storage`), so
 * the bundle loads under any profile node_modules layout. The service bodies
 * live in `host/write-service.js` and `host/preferences-service.js` and are
 * composed here onto one prototype that carries all five Remote markers.
 *
 * @module @dybai/dsh-editor
 */

import { createFileService } from './host/write-service.js';
import { createPreferencesService } from './host/preferences-service.js';

/** Cordis service key and wire namespace of the editor Host service. */
const SERVICE_KEY = 'dshEditor';
/** Fallback prototype key carrying Remote markers when live discovery fails. */
const REMOTE_DESCRIPTOR_FALLBACK = '@deepseek-ai/dsh-typert-protocol/remote-methods';

/** Host services this plugin requires; the plugin parks until they are live. */
export const inject = ['fs', 'sandboxPolicy', 'sessions', 'storage'];

/**
 * Discover the prototype property name that carries Remote method markers by
 * reading one live remote service's prototype chain, so the marker stays
 * honest across upstream key renames. Falls back to the known literal. The
 * anchors are OTHER services' keys on purpose: discovery reads their
 * prototypes, so it is unaffected by this plugin's own `dshEditor` rename.
 * @param hostCtx - the plugin's Host context.
 * @returns the descriptor property key to define on the service prototype.
 */
function remoteMarkerKey(hostCtx) {
	for (const serviceKey of ['workspaceFiles', 'directoryPickerController', 'terminalController']) {
		const service = hostCtx.get(serviceKey);
		if (service === undefined || service === null || typeof service !== 'object') continue;
		let prototype = Object.getPrototypeOf(service);
		while (prototype !== null && prototype !== Object.prototype) {
			for (const name of Object.getOwnPropertyNames(prototype)) {
				let value;
				try {
					value = Object.getOwnPropertyDescriptor(prototype, name)?.value;
				} catch {
					continue;
				}
				if (
					value !== null &&
					typeof value === 'object' &&
					value.version === 1 &&
					Array.isArray(value.methods) &&
					value.methods.every(
						(marker) => marker !== null && typeof marker === 'object' && typeof marker.method === 'string'
					)
				) {
					return name;
				}
			}
			prototype = Object.getPrototypeOf(prototype);
		}
	}
	return REMOTE_DESCRIPTOR_FALLBACK;
}

/**
 * Resolve the KV facet the mode-preference store persists through: the
 * storage hub's `json` backend (the storage hub names its backend registry
 * `backend`; `backends` is accepted for forward compatibility).
 * @param storage - the storage hub service (`ctx.storage`).
 * @returns the json backend's KvFacet.
 */
function resolveKvFacet(storage) {
	if (storage === undefined || storage === null || typeof storage !== 'object') {
		throw new Error('dsh-editor: the storage hub service is unavailable, so mode preferences cannot persist');
	}
	const registry = storage.backends ?? storage.backend;
	if (registry === undefined || typeof registry.get !== 'function') {
		throw new Error('dsh-editor: the storage hub exposes no backend registry, so the json storage backend cannot be resolved');
	}
	let backend;
	try {
		backend = registry.get('json');
	} catch (error) {
		throw new Error(`dsh-editor: resolving the json storage backend failed: ${error?.message ?? String(error)}`);
	}
	const kv = backend === undefined || backend === null ? undefined : backend.kv;
	if (kv === undefined || typeof kv.open !== 'function') {
		throw new Error('dsh-editor: the json storage backend exposes no kv facet, so mode preferences cannot persist');
	}
	return kv;
}

/**
 * Plugin entry: registers the editor Host service (workspace write + mode
 * preferences) for this fiber's lifetime.
 * @param ctx - the plugin's Host context.
 * @returns the effect disposer cordis owns.
 */
export function apply(ctx) {
	const fs = ctx.get('fs');
	if (fs === undefined || typeof fs.resolve !== 'function' || typeof fs.writeText !== 'function') {
		throw new Error('dsh-editor: the Host filesystem service with resolve/writeText is unavailable');
	}
	const sandboxPolicy = ctx.get('sandboxPolicy');
	if (sandboxPolicy === undefined || typeof sandboxPolicy.resolve !== 'function') {
		throw new Error('dsh-editor: the sandbox-policy service with resolve is unavailable');
	}
	const sessions = ctx.get('sessions');
	if (sessions === undefined || typeof sessions.get !== 'function') {
		throw new Error('dsh-editor: the session registry with get is unavailable');
	}
	const kv = resolveKvFacet(ctx.get('storage'));

	const files = createFileService(fs, sandboxPolicy, sessions);
	const preferences = createPreferencesService({ kv, now: Date.now });
	// One wire service: exactly the five Remote-marked methods on one
	// prototype, each delegating to its factory's closure.
	const service = Object.create({
		writeFile: files.writeFile,
		getModePreferences: preferences.getModePreferences,
		setModePreferences: preferences.setModePreferences,
		getKeymap: preferences.getKeymap,
		setKeymap: preferences.setKeymap
	});
	const prototype = Object.getPrototypeOf(service);
	const markerKey = remoteMarkerKey(ctx);
	Object.defineProperty(prototype, markerKey, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze([
				Object.freeze({ method: 'writeFile', invocation: Object.freeze({ kind: 'direct' }) }),
				Object.freeze({
					method: 'getModePreferences',
					invocation: Object.freeze({ kind: 'direct' })
				}),
				Object.freeze({
					method: 'setModePreferences',
					invocation: Object.freeze({ kind: 'direct' })
				}),
				Object.freeze({
					method: 'getKeymap',
					invocation: Object.freeze({ kind: 'direct' })
				}),
				Object.freeze({
					method: 'setKeymap',
					invocation: Object.freeze({ kind: 'direct' })
				})
			])
		})
	});
	service.typertRemote = Object.freeze({ service, serviceKey: SERVICE_KEY, namespace: SERVICE_KEY });

	return ctx.effect(() => {
		const disposeProvide = ctx.provide(SERVICE_KEY, service);
		return () => {
			disposeProvide();
			// Release the KV unit so a fiber restart never trips the storage
			// contract's "same unit opened twice" rejection; failure here must
			// not break disposal.
			preferences.close().catch(() => {});
		};
	}, 'dsh-editor: workspace file-write and preference services');
}
