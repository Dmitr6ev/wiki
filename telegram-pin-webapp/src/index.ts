import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { Telegraf, Markup } from 'telegraf';

type LinkItem = { url: string; description: string; orderIndex: number };
type MessageRecord = {
  id: string; // `${chatId}:${messageId}`
  chatId: number;
  messageId: number;
  creatorUserId: number;
  title: string;
  links: LinkItem[];
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
};

type DbSchema = { messages: Record<string, MessageRecord> };

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'messages.json');

function ensureDataFile(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ messages: {} }, null, 2));
}

function readDb(): DbSchema {
  ensureDataFile();
  const raw = fs.readFileSync(DB_FILE, 'utf8');
  try {
    const parsed = JSON.parse(raw);
    return parsed.messages ? parsed : { messages: {} };
  } catch {
    return { messages: {} };
  }
}

function writeDb(db: DbSchema): void {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function compileHtml(title: string, links: LinkItem[]): string {
  const lines: string[] = [];
  lines.push(`<b>${escapeHtml(title)}</b>`);
  if (links.length > 0) {
    lines.push('');
    for (const link of [...links].sort((a,b)=>a.orderIndex-b.orderIndex)) {
      if (link.description && link.description.trim()) {
        lines.push(`• <a href="${escapeHtml(link.url)}">${escapeHtml(link.description)}</a>`);
      } else {
        lines.push(`• ${escapeHtml(link.url)}`);
      }
    }
  }
  const text = lines.join('\n');
  if (text.length > 4096) {
    throw new Error('Message exceeds 4096 characters');
  }
  return text;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

const BOT_TOKEN = process.env.BOT_TOKEN;
let bot: Telegraf | null = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
  bot.start(async (ctx) => {
    await ctx.reply('Привет! Открой менеджер WebApp:', Markup.inlineKeyboard([
      [Markup.button.webApp('Открыть менеджер', process.env.WEBAPP_URL || 'https://example.com/app')]
    ]));
  });
  bot.command('manage', async (ctx) => {
    await ctx.reply('Открой менеджер WebApp:', Markup.inlineKeyboard([
      [Markup.button.webApp('Открыть менеджер', process.env.WEBAPP_URL || 'https://example.com/app')]
    ]));
  });
  (async () => {
    try {
      // Ensure polling mode locally by removing any previously set webhook
      await bot!.telegram.deleteWebhook({ drop_pending_updates: true });
      await bot!.launch({ dropPendingUpdates: true });
      console.log('Bot launched in polling mode');
    } catch (err) {
      console.error('Failed to launch bot', err);
    }
  })();
  process.once('SIGINT', () => bot?.stop('SIGINT'));
  process.once('SIGTERM', () => bot?.stop('SIGTERM'));
} else {
  console.warn('BOT_TOKEN is not set. Bot is disabled. Set BOT_TOKEN in .env');
}

// Static WebApp
app.use('/app', express.static(path.join(__dirname, '..', 'public')));

// Root
app.get('/', (_req, res) => res.status(404).json({ error: 'Not found. Use /app' }));

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// List messages for chat
app.get('/api/messages', (req, res) => {
  const chatId = Number(req.query.chat_id);
  if (!chatId) return res.status(400).json({ error: 'chat_id is required' });
  const db = readDb();
  const list = Object.values(db.messages).filter(m => m.chatId === chatId);
  res.json({ items: list });
});

// Create a new message
app.post('/api/messages', async (req, res) => {
  try {
    const { chat_id, title } = req.body || {};
    if (!chat_id || !title) return res.status(400).json({ error: 'chat_id and title are required' });
    if (!bot) return res.status(500).json({ error: 'Bot is not configured' });

    const initialHtml = compileHtml(title, []);
    const sent = await bot.telegram.sendMessage(chat_id, initialHtml, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: [[{ text: 'Редактировать', web_app: { url: (process.env.WEBAPP_URL || 'https://example.com/app') } }]] } });

    const record: MessageRecord = {
      id: `${sent.chat.id}:${sent.message_id}`,
      chatId: sent.chat.id,
      messageId: sent.message_id,
      creatorUserId: req.body.creator_user_id || 0,
      title,
      links: [],
      isPinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const db = readDb();
    db.messages[record.id] = record;
    writeDb(db);
    res.json({ item: record });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// Update message title and links
app.put('/api/messages/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const { title, links } = req.body || {};
    const db = readDb();
    const existing = db.messages[id];
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const newTitle: string = typeof title === 'string' ? title : existing.title;
    const newLinks: LinkItem[] = Array.isArray(links)
      ? links.map((l:any, idx:number)=>({
          url: String(l.url||''),
          description: String(l.description||''),
          orderIndex: typeof l.orderIndex==='number'?l.orderIndex:idx
        }))
      : existing.links;
    const html = compileHtml(newTitle, newLinks);

    if (!bot) return res.status(500).json({ error: 'Bot is not configured' });
    await bot.telegram.editMessageText(existing.chatId, existing.messageId, undefined, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

    existing.title = newTitle;
    existing.links = newLinks;
    existing.updatedAt = new Date().toISOString();
    db.messages[id] = existing;
    writeDb(db);
    res.json({ item: existing });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'failed' });
  }
});

// Pin/Unpin
app.post('/api/messages/:id/pin', async (req, res) => {
  try {
    const id = req.params.id;
    const { pin } = req.body || {};
    const db = readDb();
    const existing = db.messages[id];
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (!bot) return res.status(500).json({ error: 'Bot is not configured' });

    if (pin) {
      await bot.telegram.pinChatMessage(existing.chatId, existing.messageId, { disable_notification: true });
    } else {
      await bot.telegram.unpinChatMessage(existing.chatId, existing.messageId);
    }
    existing.isPinned = !!pin;
    existing.updatedAt = new Date().toISOString();
    db.messages[id] = existing;
    writeDb(db);
    res.json({ item: existing });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'failed' });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`HTTP server on :${port}`);
});
