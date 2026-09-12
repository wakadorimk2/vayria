import { useEffect, useRef, useState } from 'react';
import { benchmarkSummary, runManifestationBenchmark, replayDelivery, type BenchmarkRecord } from './benchmark';
export function BenchmarkPanel() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [running, setRunning] = useState(false);
  const [records, setRecords] = useState<BenchmarkRecord[]>([]);
  const [error, setError] = useState('');
  const [selection, setSelection] = useState<'all' | 'fal' | 'static' | 'runware' | 'runware-reused' | 'latency-ab' | 'latency-hosted' | 'latency-direct'>('fal');
  const [replayUrl, setReplayUrl] = useState('');
  const [trials, setTrials] = useState(1);
  useEffect(() => () => controller.current?.abort(), []);
  return <section><p>比較専用起動が必要です。費用はサーバー台帳で制限します。通常の投入は止めて実行してください。</p>
    <select aria-label="比較対象" value={selection} disabled={running} onChange={e => setSelection(e.target.value as typeof selection)}><option value="latency-ab">480p・balanced / fast</option><option value="latency-hosted">480p・fast・画像URL再利用</option><option value="latency-direct">480p・fast・直接呼出</option><option value="all">両社・動画8条件</option><option value="fal">fal・動画4条件</option><option value="runware">Runware・動画4条件</option><option value="runware-reused">Runware・元画像再利用</option><option value="static">fal・新規静止画</option></select>
    <label>試行数<input aria-label="試行数" type="number" min={1} max={5} value={trials} disabled={running} onChange={e => setTrials(Number(e.target.value))} /></label>
    <button disabled={running} onClick={() => {
      if (!canvas.current) return;
      controller.current = new AbortController(); setRunning(true); setError('');
      void runManifestationBenchmark(canvas.current, controller.current.signal, values => { setRecords(values); localStorage.setItem('manifestation-last-benchmark', JSON.stringify(values)); }, selection, trials).catch(e => setError(String(e))).finally(() => setRunning(false));
    }}>選択条件を比較（有料）</button>
    <button disabled={!running} onClick={() => controller.current?.abort()}>中断</button>
    <input aria-label="再生比較用URL" value={replayUrl} onChange={e => setReplayUrl(e.target.value)} />
    <button disabled={running || (!replayUrl && !records.some(r => r.media?.replayUrl))} onClick={() => {
      const media = replayUrl ? { url: replayUrl, replayUrl, kind: 'video' as const, composite: 'green-key' as const, mode: 'reused-base-video' as const, timings: {} } : [...records].reverse().find(r => r.media?.replayUrl)?.media;
      if (!media || !canvas.current) return;
      controller.current = new AbortController(); setRunning(true);
      void replayDelivery(canvas.current, media, controller.current.signal, values => { setRecords(values); localStorage.setItem('manifestation-last-benchmark', JSON.stringify(values)); }).catch(e => setError(String(e))).finally(() => setRunning(false));
    }}>同じ動画で配信比較（生成なし）</button>
    <button disabled={!records.length} onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ records, summary: benchmarkSummary(records) }, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'manifestation-benchmark.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }}>測定結果を保存</button>
    <canvas ref={canvas} style={{ width: 160, background: '#51415c' }} />
    <p>{error}</p><pre>{JSON.stringify(benchmarkSummary(records), null, 2)}</pre>
  </section>;
}
