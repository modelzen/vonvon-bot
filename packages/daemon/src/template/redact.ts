import { basename } from 'node:path';

export interface RedactionFinding {
  file: string;
  line?: number;
  rule: string;
  message: string;
}

const FORBIDDEN_FILENAMES = new Set([
  'memory.json',
  'events.jsonl',
  'usage.json',
  'integrity.json',
  'projects.json',
  'sessions.json',
  'bots.json',
  'config.json',
  'secrets.enc',
  'master.key',
  '.keystore.salt',
  'local-credential',
  'author-key.json',
  'device.json',
  'clients.json',
  'remote.json',
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.vonvon-template.json',
  'setup-state.json',
]);

export function isForbiddenPrivateFilename(filePath: string): boolean {
  return FORBIDDEN_FILENAMES.has(basename(filePath).toLowerCase());
}

const PLACEHOLDER_USERNAMES = new Set([
  'user', 'username', 'yourname', 'your-name', 'name', 'example', 'alice', 'bob', 'demo', 'test', 'xxx', 'placeholder',
]);

function isPlaceholderUsername(raw: string): boolean {
  const user = raw.toLowerCase();
  return PLACEHOLDER_USERNAMES.has(user)
    || /^(?:user|demo|test|example|alice|bob)\d+$/.test(user)
    || /^<.+>$/.test(user);
}

interface ContentRule {
  id: string;
  message: string;
  pattern: RegExp;
  ignore?: (match: RegExpExecArray) => boolean;
}

const CONTENT_RULES: readonly ContentRule[] = [
  {
    id: 'pem-private-key',
    message: '检测到私钥 PEM 内容',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: 'openai-anthropic-key',
    message: '检测到疑似 API Key（sk-...）',
    pattern: /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'github-token',
    message: '检测到疑似 GitHub Token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  },
  {
    id: 'slack-token',
    message: '检测到疑似 Slack Token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  },
  {
    id: 'vonvon-session-token',
    message: '检测到 Vonvon 会话令牌（vs1.）',
    pattern: /\bvs1\.[A-Za-z0-9_.-]{16,}\b/g,
  },
  {
    id: 'feishu-app-secret',
    message: '检测到疑似飞书 App Secret 明文',
    pattern: /["']?(?:app_secret|appSecret|FEISHU_APP_SECRET)["']?\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}["']?/g,
  },
  {
    id: 'feishu-private-id',
    message: '检测到疑似真实飞书群/用户私有 ID（oc_/ou_/on_）',
    pattern: /\b(?:oc|ou|on)_[a-zA-Z0-9]{12,}\b/g,
  },
  {
    id: 'feishu-app-id',
    message: '检测到疑似真实飞书应用 ID（cli_）',
    pattern: /\bcli_[a-f0-9]{12,}\b/g,
  },
  {
    id: 'unix-home-path',
    message: '检测到疑似本机用户绝对路径（/Users/... 或 /home/...）',
    pattern: /(?:\/Users|\/home)\/([A-Za-z0-9._-]+)(?:\/|(?=["'\s)]|$))/g,
    ignore: (match) => isPlaceholderUsername(match[1] ?? ''),
  },
  {
    id: 'windows-home-path',
    message: '检测到疑似 Windows 本机用户绝对路径（C:\\Users\\...）',
    pattern: /\b[A-Za-z]:\\{1,2}Users\\{1,2}([A-Za-z0-9._-]+)(?:\\|(?=["'\s)]|$))/g,
    ignore: (match) => isPlaceholderUsername(match[1] ?? ''),
  },
];

function decodeTextIfPossible(data: Buffer): string | undefined {
  if (data.length >= 2) {
    if (data[0] === 0xff && data[1] === 0xfe) {
      const body = data.subarray(2);
      const evenLen = body.length - (body.length % 2);
      return body.subarray(0, evenLen).toString('utf16le');
    }
    if (data[0] === 0xfe && data[1] === 0xff) {
      const body = data.subarray(2);
      const evenLen = body.length - (body.length % 2);
      if (evenLen === 0) return '';
      const swapped = Buffer.from(body.subarray(0, evenLen));
      swapped.swap16();
      return swapped.toString('utf16le');
    }
  }
  const sampleLen = Math.min(data.length, 4096);
  let zeroCount = 0;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (data[i] === 0) {
      zeroCount++;
      if (i % 2 === 0) evenZero++;
      else oddZero++;
    }
  }
  if (zeroCount === 0) return data.toString('utf8');
  // Heuristic for BOM-less UTF-16 ASCII/BMP text (e.g. PowerShell output).
  const half = Math.floor(sampleLen / 2);
  if (half >= 8 && oddZero >= half * 0.6 && evenZero <= half * 0.1) {
    return data.toString('utf16le');
  }
  if (half >= 8 && evenZero >= half * 0.6 && oddZero <= half * 0.1) {
    const evenLen = data.length - (data.length % 2);
    const swapped = Buffer.from(data.subarray(0, evenLen));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return undefined;
}

const ENV_TEMPLATE_FILES = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist']);
const SENSITIVE_ENV_KEY_RE = /(?:SECRET|PASSWORD|PASSWD|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL|DATABASE_URL|DSN|AUTH_?KEY)/i;
const PLACEHOLDER_ENV_VAL_RE = /^(?:$|replace[-_]?me|change[-_]?me|your[-_a-z0-9]*|example[-_a-z0-9]*|placeholder|dummy|sample|test|xxx+|todo|none|null|false|true|\d+|<[^>]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|https?:\/\/(?:localhost|127\.0\.0\.1|example\.(?:com|org|net))(?:[:/].*)?)$/i;

function isSuspiciousEnvTemplateLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  const m = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) return false;
  const key = m[1]!;
  if (!SENSITIVE_ENV_KEY_RE.test(key)) return false;
  let val = m[2]!.trim();
  // Strip trailing inline comment outside quotes
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1).trim();
  } else {
    val = val.replace(/\s+#.*$/, '').trim();
  }
  return !PLACEHOLDER_ENV_VAL_RE.test(val);
}

/**
 * Scan candidate template files before packing. Rejects forbidden Vonvon private state files,
 * credentials, real Feishu IDs, and local absolute user paths.
 */
export function scanFilesForSecrets(files: readonly { path: string; data: Buffer }[]): RedactionFinding[] {
  const findings: RedactionFinding[] = [];

  for (const file of files) {
    const base = basename(file.path).toLowerCase();
    if (FORBIDDEN_FILENAMES.has(base)) {
      findings.push({
        file: file.path,
        rule: 'forbidden-file',
        message: `禁止将私密或运行状态文件打入配方包：${file.path}`,
      });
      continue;
    }

    const text = decodeTextIfPossible(file.data);
    if (text === undefined) continue;
    const lines = text.split(/\r?\n/);
    const isEnvTemplate = ENV_TEMPLATE_FILES.has(base);

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!;
      if (isEnvTemplate && isSuspiciousEnvTemplateLine(line)) {
        findings.push({
          file: file.path,
          line: idx + 1,
          rule: 'env-template-secret',
          message: '检测到 .env 模板文件中包含非占位符的敏感配置值，请替换为占位符或留空',
        });
      }
      for (const rule of CONTENT_RULES) {
        rule.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = rule.pattern.exec(line)) !== null) {
          if (rule.ignore?.(match)) continue;
          findings.push({
            file: file.path,
            line: idx + 1,
            rule: rule.id,
            message: rule.message,
          });
          break;
        }
      }
    }
  }

  return findings;
}

/** Run the same secret/PII redaction check on outbound promo payloads before sending to Club. */
export function scanPromoForSecrets(promo: unknown): RedactionFinding[] {
  const data = Buffer.from(`${JSON.stringify(promo, null, 2)}\n`, 'utf8');
  return scanFilesForSecrets([{ path: 'promo.json', data }]);
}
