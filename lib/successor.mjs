// Explicit, operator-authorized maintenance. No title matching or automatic forks.
// Compatible with the running 0.2.6 plugin; does not replace that plugin.
import { createReadStream, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { join } from 'node:path';
import { need } from './store.mjs';

const sessionId = /^session-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const json = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
export async function readHeaderOnly(path) {
  const input = createReadStream(path), decoder = input.pipe(createZstdDecompress());
  let buffer = Buffer.alloc(0);
  input.on('error', error => decoder.destroy(error));
  try {
    for await (const chunk of decoder) {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      need(end >= 0 || buffer.length < 65536, 'SESSION_HEADER_TOO_LARGE');
      if (end < 0) continue;
      need(end < 65536, 'SESSION_HEADER_TOO_LARGE');
      const h = JSON.parse(buffer.subarray(0, end).toString('utf8'));
      need(h.type === 'session' && h.version === 4, 'UNSUPPORTED_SESSION_HEADER');
      return { id: h.id, parentSession: h.parentSession, isSeeded: h.isSeeded, createdAt: h.createdAt };
    }
    throw new Error('SESSION_HEADER_MISSING');
  } finally { input.destroy(); decoder.destroy(); }
}
export async function inspectSuccessor(home, from, to, workspaceId) {
  need(sessionId.test(from) && sessionId.test(to) && from !== to, 'INVALID_SUCCESSOR_IDS');
  const workspace = json(join(home, 'storages/workspace.json'));
  const members = workspace.tables.workspaces[workspaceId]?.sessionIds;
  need(Array.isArray(members), 'WORKSPACE_NOT_FOUND');
  const locate = id => {
    const hits = readdirSync(join(home, 'sessions'), { withFileTypes: true }).filter(e => e.isDirectory())
      .flatMap(e => readdirSync(join(home, 'sessions', e.name)).includes(id)
        ? [join(home, 'sessions', e.name, id, 'session.v4.jsonl.zstd')] : []);
    need(hits.length === 1, 'SESSION_FILE_NOT_UNIQUE'); return hits[0];
  };
  const [parent, child] = await Promise.all([readHeaderOnly(locate(from)), readHeaderOnly(locate(to))]);
  need(parent.id === from && child.id === to && child.parentSession === from && child.isSeeded === true,
    'SUCCESSOR_LINEAGE_MISMATCH');
  need(members.includes(to) && !members.includes(from), 'SUCCESSOR_WORKSPACE_MISMATCH');
  need(!workspace.global.archivedSessionIds.includes(to), 'SUCCESSOR_ARCHIVED');
  return { from, to, workspaceId, parent, child, sourceDetached: true, successorArchived: false };
}
export function migrationPlan(store, input, facts) {
  need(input.authorization === 'user-approved', 'EXPLICIT_SUCCESSOR_AUTHORIZATION_REQUIRED');
  const route = store.route(input.routeKey);
  need(route.revision === input.expectedRevision && route.dshSessionId === input.from, 'BINDING_REVISION_MISMATCH');
  need(facts.from === input.from && facts.to === input.to && facts.workspaceId === route.dshWorkspaceId
    && facts.child?.parentSession === input.from && facts.child?.id === input.to && facts.child?.isSeeded === true
    && facts.sourceDetached === true && facts.successorArchived === false, 'SUCCESSOR_FACTS_MISMATCH');
  need(!store.routes().some(r => r.key !== route.key && r.dshSessionId === input.to), 'SESSION_ALREADY_BOUND');
  const rows = store.db.prepare('SELECT id,direction,state FROM messages WHERE route=? ORDER BY id').all(route.key);
  // Unknown/accepted/in-flight transports require receipt reconciliation first.
  need(!rows.some(r => r.direction === 'dsh' && ['dispatching', 'accepted', 'unknown'].includes(r.state)), 'SOURCE_DELIVERY_UNRESOLVED');
  need(!rows.some(r => r.direction === 'dsh' && r.state === 'started' && store.message(r.id).execution.actionable), 'SOURCE_WORK_STILL_ACTIVE');
  const carry = rows.filter(r => r.direction === 'dsh' && r.state === 'queued' && store.message(r.id).execution.actionable).map(r => r.id);
  need(Array.isArray(input.carryMessageIds) && JSON.stringify([...new Set(input.carryMessageIds)].sort()) === JSON.stringify(carry), 'CARRY_SET_MISMATCH');
  return { route, carry, preserved: rows.filter(r => !carry.includes(r.id)), facts };
}
export function applySuccessor(store, input, facts) {
  return store.transaction(() => {
    const plan = migrationPlan(store, input, facts);
    // Fail closed unless the running relay observed the detached source during
    // this maintenance pass. A cached ready=true is never sufficient.
    const live = store.health('route:' + input.routeKey);
    need(Number.isFinite(input.observedAfter) && live?.time >= input.observedAfter && live.ageMs <= 30000 && live.ready === false
      && ['SESSION_ARCHIVED', 'WORKSPACE_MISMATCH', 'SESSION_NOT_VISIBLE'].includes(live.code), 'FRESH_SOURCE_UNAVAILABLE_REQUIRED');
    const { revision, ...data } = plan.route;
    data.dshSessionId = input.to;
    // Keep all permissions, workstreams, titles, Codex identity and model settings.
    const updated = store.db.prepare('UPDATE routes SET data=?,revision=revision+1 WHERE key=? AND revision=?')
      .run(JSON.stringify(data), input.routeKey, revision);
    need(updated.changes === 1, 'BINDING_REVISION_MISMATCH');
    store.heartbeat('route:' + input.routeKey, { ready: false, code: 'SUCCESSOR_HANDSHAKE_PENDING', identityMatched: false });
    store.event(null, 'binding-successor-migrated', { route: input.routeKey, from: input.from, to: input.to,
      oldRevision: revision, revision: revision + 1, carryMessageIds: plan.carry, historyPreserved: true,
      parentSession: facts.child.parentSession, authorization: 'user-approved' });
    return { route: store.route(input.routeKey), carryMessageIds: plan.carry, preservedMessageCount: plan.preserved.length };
  });
}
export function syncSuccessorPolicy(store, configPath, routeKey, previous) {
  const config = json(configPath), route = store.route(routeKey), policy = config.routes?.[routeKey];
  need(policy && policy.codexThreadId === route.codexThreadId && typeof policy.businessPaused === 'boolean', 'POLICY_BINDING_MISMATCH');
  need((policy.dshSessionId === previous.from && policy.revision === previous.expectedRevision)
    || (policy.dshSessionId === route.dshSessionId && policy.revision === route.revision), 'POLICY_BINDING_MISMATCH');
  config.routes[routeKey] = { ...policy, dshSessionId: route.dshSessionId, revision: route.revision };
  const temp = configPath + '.successor.tmp'; writeFileSync(temp, JSON.stringify(config, null, 2) + '\n'); renameSync(temp, configPath);
  return config.routes[routeKey];
}
