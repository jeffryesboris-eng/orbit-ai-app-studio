"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { GeneratedApp } from "@/lib/generation-contract";

export type PersistenceProject = {
  id: string;
  title: string;
  summary: string;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type PersistenceMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type PersistenceVersion = GeneratedApp & {
  id: string;
  project_id: string;
  version_number: number;
  created_at: string;
};

export type LoadedProject = {
  project: PersistenceProject;
  messages: PersistenceMessage[];
  currentVersion: PersistenceVersion | null;
};

let browserClient: SupabaseClient | null | undefined;

export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
    && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
  );
}

export function getSupabaseClient() {
  if (browserClient !== undefined) return browserClient;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  browserClient = url && publishableKey
    ? createClient(url, publishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      })
    : null;
  return browserClient;
}

export async function ensureAnonymousSession(client: SupabaseClient) {
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session) return sessionData.session.user;

  const { data, error } = await client.auth.signInAnonymously();
  if (error) throw error;
  if (!data.user) throw new Error("匿名身份创建失败");
  return data.user;
}

export async function listProjects(client: SupabaseClient) {
  const { data, error } = await client
    .from("projects")
    .select("id,title,summary,current_version_id,created_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  return (data || []) as PersistenceProject[];
}

export async function loadProject(client: SupabaseClient, projectId: string): Promise<LoadedProject> {
  const { data: project, error: projectError } = await client
    .from("projects")
    .select("id,title,summary,current_version_id,created_at,updated_at")
    .eq("id", projectId)
    .single();
  if (projectError) throw projectError;

  const messagesQuery = client
    .from("messages")
    .select("id,role,content,created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  const versionQuery = project.current_version_id
    ? client
        .from("code_versions")
        .select("id,project_id,version_number,title,summary,html,created_at")
        .eq("id", project.current_version_id)
        .single()
    : Promise.resolve({ data: null, error: null });

  const [messagesResult, versionResult] = await Promise.all([messagesQuery, versionQuery]);
  if (messagesResult.error) throw messagesResult.error;
  if (versionResult.error) throw versionResult.error;

  return {
    project: project as PersistenceProject,
    messages: (messagesResult.data || []) as PersistenceMessage[],
    currentVersion: versionResult.data as PersistenceVersion | null,
  };
}

export async function saveGeneration(
  client: SupabaseClient,
  input: {
    projectId: string | null;
    prompt: string;
    app: GeneratedApp;
    assistantMessage: string;
  },
) {
  const { data, error } = await client.rpc("save_generation", {
    p_project_id: input.projectId,
    p_user_message: input.prompt,
    p_title: input.app.title,
    p_summary: input.app.summary,
    p_html: input.app.html,
    p_assistant_message: input.assistantMessage,
  });
  if (error) throw error;
  const saved = Array.isArray(data) ? data[0] : data;
  if (!saved?.project_id || !saved?.version_id) throw new Error("数据库没有返回已保存版本");
  return saved as { project_id: string; version_id: string; version_number: number };
}

export async function listVersions(client: SupabaseClient, projectId: string) {
  const { data, error } = await client
    .from("code_versions")
    .select("id,project_id,version_number,title,summary,html,created_at")
    .eq("project_id", projectId)
    .order("version_number", { ascending: false });
  if (error) throw error;
  return (data || []) as PersistenceVersion[];
}

export async function restoreVersion(client: SupabaseClient, projectId: string, versionId: string) {
  const { data, error } = await client.rpc("restore_version", {
    p_project_id: projectId,
    p_version_id: versionId,
  });
  if (error) throw error;
  const restored = Array.isArray(data) ? data[0] : data;
  if (!restored?.version_id || !restored?.html) throw new Error("数据库没有返回恢复后的版本");
  return restored as GeneratedApp & { version_id: string; version_number: number };
}

\n