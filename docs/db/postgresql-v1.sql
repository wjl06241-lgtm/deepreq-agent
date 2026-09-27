-- 需求助手多人版；独立 schema，不修改旧表。首次安装执行一次。
-- UUID 由应用生成；不需要数据库扩展。所有时间存 timestamptz。
BEGIN;
CREATE SCHEMA requirement_assistant;

CREATE TABLE requirement_assistant.users (
  id uuid PRIMARY KEY,
  platform text NOT NULL DEFAULT 'feishu',
  app_id text NOT NULL,
  external_user_id text NOT NULL CHECK (external_user_id <> ''),
  display_name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  profile_status text NOT NULL DEFAULT 'unavailable',
  profile_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, app_id, external_user_id)
);

CREATE TABLE requirement_assistant.projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- 空字符串对应当前程序的“默认项目”，避免 NULL 导致唯一约束失效。
INSERT INTO requirement_assistant.projects (id, name) VALUES ('', '默认项目');

-- 一个用户在一个聊天中拥有一个独立的项目选择。
CREATE TABLE requirement_assistant.user_chat_settings (
  user_id uuid NOT NULL REFERENCES requirement_assistant.users(id),
  chat_id text NOT NULL,
  active_project_id text NOT NULL DEFAULT '' REFERENCES requirement_assistant.projects(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_id)
);

CREATE TABLE requirement_assistant.conversations (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES requirement_assistant.users(id),
  chat_id text NOT NULL CHECK (chat_id <> ''),
  project_id text NOT NULL DEFAULT '' REFERENCES requirement_assistant.projects(id),
  agent_id text NOT NULL DEFAULT 'requirement-assistant',
  backend text NOT NULL DEFAULT 'codex',
  codex_thread_id text,
  title text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX conversations_one_active
  ON requirement_assistant.conversations (user_id, chat_id, project_id, agent_id)
  WHERE status = 'active';
CREATE INDEX conversations_owner ON requirement_assistant.conversations (user_id, updated_at DESC);

-- 一行一条消息；助手消息的 user_id 也指向会话所有者。
CREATE TABLE requirement_assistant.messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  sequence_no bigint GENERATED ALWAYS AS IDENTITY,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content text NOT NULL DEFAULT '',
  external_message_id text,
  reply_to_id uuid,
  status text NOT NULL DEFAULT 'completed',
  usage jsonb,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  stored_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, conversation_id, user_id),
  FOREIGN KEY (conversation_id, user_id)
    REFERENCES requirement_assistant.conversations(id, user_id),
  FOREIGN KEY (reply_to_id, conversation_id, user_id)
    REFERENCES requirement_assistant.messages(id, conversation_id, user_id)
);
CREATE INDEX messages_history ON requirement_assistant.messages (user_id, conversation_id, created_at, sequence_no);

CREATE TABLE requirement_assistant.tasks (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  input_message_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
  result text,
  error text,
  delivery_status text NOT NULL DEFAULT 'pending',
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  delivery_progress jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (input_message_id),
  UNIQUE (id, conversation_id, user_id),
  FOREIGN KEY (conversation_id, user_id) REFERENCES requirement_assistant.conversations(id, user_id),
  FOREIGN KEY (input_message_id, conversation_id, user_id)
    REFERENCES requirement_assistant.messages(id, conversation_id, user_id)
);
CREATE INDEX tasks_owner ON requirement_assistant.tasks (user_id, created_at DESC);

-- 平台重投去重跨越 /new；与消息、任务在同一事务写入。
CREATE TABLE requirement_assistant.inbound_events (
  platform text NOT NULL,
  app_id text NOT NULL,
  chat_id text NOT NULL,
  external_message_id text NOT NULL,
  message_id uuid NOT NULL REFERENCES requirement_assistant.messages(id),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, app_id, chat_id, external_message_id)
);

CREATE TABLE requirement_assistant.attachments (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  message_id uuid,
  task_id uuid,
  kind text NOT NULL CHECK (kind IN ('upload', 'output')),
  filename text NOT NULL,
  mime_type text,
  size_bytes bigint CHECK (size_bytes >= 0),
  sha256 text,
  storage_provider text NOT NULL DEFAULT 'local',
  storage_key text NOT NULL,
  parse_status text NOT NULL DEFAULT 'pending',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, user_id) REFERENCES requirement_assistant.conversations(id, user_id),
  FOREIGN KEY (message_id, conversation_id, user_id)
    REFERENCES requirement_assistant.messages(id, conversation_id, user_id),
  FOREIGN KEY (task_id, conversation_id, user_id)
    REFERENCES requirement_assistant.tasks(id, conversation_id, user_id)
);
CREATE INDEX attachments_owner ON requirement_assistant.attachments(user_id, conversation_id);

-- 旧数据先原样暂存，未确认归属的数据不进入聊天检索。
CREATE TABLE requirement_assistant.legacy_imports (
  source_system text NOT NULL,
  source_table text NOT NULL,
  source_id text NOT NULL,
  raw_record jsonb NOT NULL,
  mapped_user_id uuid REFERENCES requirement_assistant.users(id),
  imported_message_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'failed')),
  error text,
  imported_at timestamptz,
  PRIMARY KEY (source_system, source_table, source_id)
);
COMMIT;
