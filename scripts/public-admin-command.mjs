export function adminCommand(action = 'report', argument) {
  if (action === 'report' || action === 'exhibition-list') return { op: 'report' };
  if (action === 'stop' || action === 'resume') return { op: 'configure', stopped: action === 'stop' };
  if (action === 'configure' && argument) return { op: 'configure', patch: JSON.parse(argument) };
  if (action === 'exhibition-create') {
    const input = argument ? JSON.parse(argument) : { event: 'expo-20260923', starts: '2026-09-23T00:00:00+09:00', expires: '2026-09-24T00:00:00+09:00', budgetYen: 10000 };
    const starts = Date.parse(input.starts); const expires = Date.parse(input.expires); const budget = input.budgetYen * 1e6;
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.event ?? '') || !Number.isSafeInteger(starts) || !Number.isSafeInteger(expires) ||
      expires <= starts || expires - starts > 86400_000 || !Number.isSafeInteger(budget) || budget <= 0) throw new Error('Specify event, ISO starts/expires (at most 24 hours), and positive budgetYen');
    return { op: action, event: input.event, starts, expires, budget };
  }
  if ((action === 'exhibition-code' || action === 'exhibition-stop') && /^[a-zA-Z0-9_-]{1,64}$/.test(argument ?? '')) return { op: action, event: argument };
  if (action === 'exhibition-revoke' && /^[a-f0-9-]{36}$/.test(argument ?? '')) return { op: action, visitor: argument };
  throw new Error('Usage: public-admin.mjs report|stop|resume|configure JSON|exhibition-create [JSON]|exhibition-list|exhibition-code EVENT|exhibition-stop EVENT|exhibition-revoke VISITOR');
}
