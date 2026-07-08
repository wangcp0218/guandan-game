import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const DB_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DB_DIR, 'users.json');
const RECORDS_FILE = path.join(DB_DIR, 'records.json');

function ensureDb() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
  if (!fs.existsSync(RECORDS_FILE)) fs.writeFileSync(RECORDS_FILE, '[]');
}

function readJson(file: string): any[] {
  ensureDb();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
}

function writeJson(file: string, data: any[]) {
  ensureDb();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

export function createUser(username: string, passwordHash: string): string {
  const users = readJson(USERS_FILE);
  const id = uuidv4();
  users.push({ id, username, password_hash: passwordHash, level: 2, created_at: new Date().toISOString() });
  writeJson(USERS_FILE, users);
  return id;
}

export function findUserByUsername(username: string) {
  const users = readJson(USERS_FILE);
  return users.find((u: any) => u.username === username) || null;
}

export function findUserById(id: string) {
  const users = readJson(USERS_FILE);
  return users.find((u: any) => u.id === id) || null;
}

export function updateUserLevel(id: string, level: number) {
  const users = readJson(USERS_FILE);
  const idx = users.findIndex((u: any) => u.id === id);
  if (idx >= 0) {
    users[idx].level = level;
    writeJson(USERS_FILE, users);
  }
}

export function saveGameRecord(record: {
  id: string;
  roomId: string;
  playerIds: string[];
  winnerTeam: number;
  finalLevel: number;
  rankingJson: string;
}) {
  const records = readJson(RECORDS_FILE);
  records.push({
    id: record.id,
    room_id: record.roomId,
    player1_id: record.playerIds[0],
    player2_id: record.playerIds[1],
    player3_id: record.playerIds[2],
    player4_id: record.playerIds[3],
    winner_team: record.winnerTeam,
    final_level: record.finalLevel,
    ranking_json: record.rankingJson,
    created_at: new Date().toISOString(),
  });
  writeJson(RECORDS_FILE, records);
}
