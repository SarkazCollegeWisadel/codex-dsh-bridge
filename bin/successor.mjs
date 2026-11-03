#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { backup } from 'node:sqlite';
import { Store, DEFAULT_ROOT, need } from '../lib/store.mjs';
import { inspectSuccessor, migrationPlan, applySuccessor, syncSuccessorPolicy } from '../lib/successor.mjs';
const [command, flag, path] = process.argv.slice(2);
let store;
try {
  need(['inspect', 'refresh', 'apply', 'sync-policy'].includes(command) && flag === '--json-file' && path, 'USAGE_successor_inspect_refresh_apply_sync-policy_--json-file');
  const input = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  store = new Store(process.env.DSH_CODEX_BRIDGE_ROOT || DEFAULT_ROOT);
  const configPath = join(store.root, 'state/event-worker.config.json');
  if (command === 'sync-policy') {
    need(input.authorization === 'user-approved', 'EXPLICIT_SUCCESSOR_AUTHORIZATION_REQUIRED');
    const route = store.route(input.routeKey);
    need(route.dshSessionId === input.to && route.revision === input.expectedRevision + 1, 'BINDING_REVISION_MISMATCH');
    console.log(JSON.stringify({ ok: true, policy: syncSuccessorPolicy(store, configPath, input.routeKey, input) }));
  } else {
    const facts = await inspectSuccessor(input.dshHome, input.from, input.to, store.route(input.routeKey).dshWorkspaceId);
    const plan = migrationPlan(store, input, facts);
    if (command === 'inspect') console.log(JSON.stringify({ ok: true, facts, carryMessageIds: plan.carry, preservedMessageCount: plan.preserved.length }));
    else if (command === 'refresh') {
      const observedAfter = Date.now();
      store.event(null, 'successor-inspection-request', { route: input.routeKey, from: input.from, to: input.to, readOnly: true });
      console.log(JSON.stringify({ ok: true, observedAfter, action: 'Wait for route health with time >= observedAfter; no model wake or business message created.' }));
    }
    else {
      // Local private state only. Never restore this database over later messages.
      const dir = join(store.root, 'backups', 'successor-' + Date.now(), 'v-2'); mkdirSync(dir, { recursive: true });
      await backup(store.db, join(dir, 'bridge.private.sqlite'));
      writeFileSync(join(dir, 'event-worker.config.json'), readFileSync(configPath));
      writeFileSync(join(dir, 'operation.json'), JSON.stringify({ input, facts, previousRoute: plan.route }, null, 2));
      // Re-read facts after backup; no history files or workspace storage are written.
      const fresh = await inspectSuccessor(input.dshHome, input.from, input.to, plan.route.dshWorkspaceId);
      const result = applySuccessor(store, input, fresh);
      const policy = syncSuccessorPolicy(store, configPath, input.routeKey, input);
      console.log(JSON.stringify({ ok: true, maintenanceVersion: 1, runningPluginRequired: '0.2.6', backup: dir, ...result, policy }));
    }
  }
} catch (error) { console.error(JSON.stringify({ ok: false, error: error.code || error.message })); process.exitCode = 1; }
finally { store?.close(); }
