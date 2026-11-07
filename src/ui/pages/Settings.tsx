// ABOUTME: 设置页：通用 / 自动化 / 识别 / 诊断与高级四个分区；所有路径只在这里编辑。

import { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import type { SettingEntry } from '../../contracts/app';
import { api } from '../api';
import { useAsyncData } from '../useApi';
import { Button, Card, ErrorState, Field, Loading, useToast } from '../components/ui';
import { DiagnosticsSection } from './settings/DiagnosticsSection';

const GENERAL_FIELDS: Array<{ key: string; label: string; hint: string; placeholder: string }> = [
  {
    key: 'library_dir',
    label: '录音库目录',
    hint: '留空默认 ~/memo/memotalk/raw；同步和导入的录音按年月自动分文件夹保存',
    placeholder: '~/memo/memotalk/raw',
  },
  {
    key: 'import_dir',
    label: '导入目录',
    hint: '「录音 › 导入」从这个文件夹读取录音文件；留空使用默认文件夹',
    placeholder: '~/memo/memotalk/inbox',
  },
];

const AUTOMATION_FLAGS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'auto_transcribe', label: '新录音进库后自动转录', hint: '同步或导入完成后立即开始转录，不用手动点「开始转录」' },
  { key: 'auto_analyze', label: '转录后自动 AI 归类', hint: '转录完成后自动生成标题、摘要与分类' },
  { key: 'auto_connect', label: '自动连接录音笔', hint: '工作台打开时定期尝试连接，录音笔唤醒后自动接上；手动断开后会暂停' },
  { key: 'auto_pull', label: '连上录音笔后自动同步新录音', hint: '点「连接」后直接开始同步；后台自动连接时只同步较小的录音' },
  {
    key: 'auto_pull_wifi',
    label: '后台自动同步大录音时也用无线快传（会暂时断开外网）',
    hint: '默认关闭：后台不会切换电脑的网络，大录音留到你手动同步',
  },
];

const RECOGNITION_FLAGS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'speaker_diarization', label: '区分说话人', hint: '识别结果区分不同说话人；较长录音耗时略增' },
];

const DIAGNOSTIC_TEXT_KEYS = ['python_path', 'ffmpeg_path'];

export function SettingsPage({ section }: { section?: 'diagnostics' }) {
  const toast = useToast();
  const state = useAsyncData<SettingEntry[]>(() => api.get<SettingEntry[]>('/api/settings'), 'settings');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const saved = useMemo(() => {
    const next: Record<string, string> = {};
    for (const entry of state.data ?? []) next[entry.key] = entry.value;
    return next;
  }, [state.data]);

  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const value = (key: string): string => draft[key] ?? '';
  const update = (key: string, next: string) => setDraft((current) => ({ ...current, [key]: next }));
  const dirty = Object.keys(draft).some((key) => (draft[key] ?? '') !== (saved[key] ?? ''));

  if (state.loading && !state.data) return <Loading label="正在读取设置" />;
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;

  const save = async () => {
    setBusy(true);
    try {
      const values: Record<string, string> = {};
      for (const field of GENERAL_FIELDS) values[field.key] = value(field.key);
      for (const key of DIAGNOSTIC_TEXT_KEYS) values[key] = value(key);
      for (const field of [...AUTOMATION_FLAGS, ...RECOGNITION_FLAGS]) values[field.key] = value(field.key) === '1' ? '1' : '0';
      values.auto_connect_minutes = value('auto_connect_minutes') || '3';
      values.device_transport = value('device_transport') || 'auto';
      values.asr_hotwords = value('asr_hotwords');
      values.asr_language = value('asr_language');
      await api.patch('/api/settings', { values });
      toast.push('设置已保存', 'success');
      state.reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  };

  const flag = (field: { key: string; label: string; hint: string }, disabled = false) => (
    <label key={field.key} className="switch switch--row">
      <input
        type="checkbox"
        checked={value(field.key) === '1'}
        disabled={disabled}
        onChange={(event) => update(field.key, event.target.checked ? '1' : '0')}
      />
      <span>
        <span className="switch__label">{field.label}</span>
        <span className="switch__hint">{field.hint}</span>
      </span>
    </label>
  );

  return (
    <div className="page page--settings">
      <header className="page__head">
        <div>
          <h1>设置</h1>
          <p className="page__sub">设置只保存在本机，不会上传任何凭据。</p>
        </div>
        <div className="page__actions">
          {dirty ? <span className="settings__dirty">有未保存的修改</span> : null}
          <Button variant="primary" icon={<Save size={15} aria-hidden="true" />} disabled={busy || !dirty} onClick={() => void save()}>
            保存设置
          </Button>
        </div>
      </header>

      <div className="device-grid">
        <Card title="通用">
          {GENERAL_FIELDS.map((field) => (
            <Field key={field.key} label={field.label} hint={field.hint}>
              <input value={value(field.key)} placeholder={field.placeholder} onChange={(event) => update(field.key, event.target.value)} />
            </Field>
          ))}
        </Card>

        <Card title="自动化">
          {AUTOMATION_FLAGS.slice(0, 3).map((field) => flag(field))}
          <Field label="自动连接间隔（分钟）" hint="间隔越短越及时，也越耗录音笔电量">
            <input
              type="number"
              min={1}
              max={120}
              value={value('auto_connect_minutes')}
              disabled={value('auto_connect') !== '1'}
              onChange={(event) => update('auto_connect_minutes', event.target.value)}
            />
          </Field>
          {flag(AUTOMATION_FLAGS[3])}
          {flag(AUTOMATION_FLAGS[4], value('auto_pull') !== '1' || value('auto_connect') !== '1')}
        </Card>

        <Card title="识别">
          {RECOGNITION_FLAGS.map((field) => flag(field))}
          <Field label="识别热词" hint="用逗号分隔，提升专有名词识别率">
            <input
              value={value('asr_hotwords')}
              placeholder="例如：MemoTalk, 复购率, 私域"
              onChange={(event) => update('asr_hotwords', event.target.value)}
            />
          </Field>
          <Field label="识别语言" hint="留空由识别引擎自动判断">
            <select value={value('asr_language')} onChange={(event) => update('asr_language', event.target.value)}>
              <option value="">自动</option>
              <option value="zh">中文</option>
              <option value="en">英文</option>
              <option value="ja">日文</option>
            </select>
          </Field>
        </Card>
      </div>

      <DiagnosticsSection focus={section === 'diagnostics'} value={value} update={update} />
    </div>
  );
}
