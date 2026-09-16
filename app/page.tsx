"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  Cloud,
  CloudOff,
  Code2,
  Columns3,
  Copy,
  ExternalLink,
  History,
  Laptop,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { generateDemoApp } from "@/lib/demo-generator";
import {
  MAX_PROMPT_LENGTH,
  type GeneratedApp,
  type GenerationRequest,
  type GenerationResponse,
} from "@/lib/generation-contract";
import {
  ensureAnonymousSession,
  getSupabaseClient,
  isSupabaseConfigured,
  listProjects,
  listVersions,
  loadProject,
  restoreVersion,
  saveGeneration,
  type PersistenceProject,
  type PersistenceVersion,
} from "@/lib/supabase-client";

type Message = { id: string; role: "user" | "assistant"; content: string };
type PersistenceStatus = "connecting" | "ready" | "unconfigured" | "error";

const samplePrompts = ["做一个学习任务管理器", "做一个贷款计算器", "做一个客户数据看板"];
const initialResult = generateDemoApp("生成一个学习任务管理器，支持添加、完成、删除和筛选任务");
const initialMessages: Message[] = [{
  id: "welcome",
  role: "assistant",
  content: "示例应用已经准备好了。你可以直接操作右侧预览，也可以描述一个新想法，我会重新生成。",
}];

function formatVersionDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [result, setResult] = useState<GeneratedApp>(initialResult);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState("等待新需求");
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [lastFailedRequest, setLastFailedRequest] = useState<GenerationRequest | null>(null);
  const [isModelBacked, setIsModelBacked] = useState(false);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [copied, setCopied] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [persistenceStatus, setPersistenceStatus] = useState<PersistenceStatus>("connecting");
  const [projects, setProjects] = useState<PersistenceProject[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<PersistenceVersion[]>([]);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [restoringVersionId, setRestoringVersionId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    async function initialize() {
      if (!isSupabaseConfigured()) {
        if (mounted) setPersistenceStatus("unconfigured");
        return;
      }

      const client = getSupabaseClient();
      if (!client) {
        if (mounted) setPersistenceStatus("unconfigured");
        return;
      }

      try {
        await ensureAnonymousSession(client);
        const savedProjects = await listProjects(client);
        if (!mounted) return;
        setProjects(savedProjects);
        setPersistenceStatus("ready");

        if (savedProjects[0]) {
          const loaded = await loadProject(client, savedProjects[0].id);
          if (!mounted) return;
          setActiveProjectId(loaded.project.id);
          setCurrentVersionId(loaded.project.current_version_id);
          setMessages(loaded.messages.length ? loaded.messages : initialMessages);
          if (loaded.currentVersion) {
            setResult(loaded.currentVersion);
            setIsModelBacked(true);
            setPreviewKey((value) => value + 1);
            setGenerationStep("已恢复云端项目");
          }
        }
      } catch (error) {
        console.error("Supabase initialization failed", error instanceof Error ? error.message : "unknown");
        if (mounted) {
          setPersistenceStatus("error");
          setGenerationError("无法连接云端数据，当前仍可临时生成应用。");
        }
      }
    }

    initialize();
    return () => { mounted = false; };
  }, []);

  async function runGeneration(request: GenerationRequest, appendUserMessage: boolean) {
    if (isGenerating || persistenceStatus === "connecting") return;
    if (appendUserMessage) {
      setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", content: request.prompt }]);
      setPrompt("");
    }
    setIsGenerating(true);
    setGenerationError(null);
    setGenerationStep("正在理解你的需求");
    const stepTimer = window.setTimeout(() => setGenerationStep("正在生成并检查可运行代码"), 900);

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = await response.json() as GenerationResponse;
      if (!response.ok || !payload.ok) {
        setGenerationError(payload.ok ? "生成失败，请重试。" : payload.error.message);
        setLastFailedRequest(!payload.ok && payload.error.retryable ? request : null);
        setGenerationStep("生成失败");
        return;
      }

      const assistantContent = `${payload.data.summary.replace(/[。.!！?？]+$/, "")}。右侧预览已更新，可以直接体验。`;
      let savedVersion: { project_id: string; version_id: string; version_number: number } | null = null;

      if (persistenceStatus === "ready") {
        const client = getSupabaseClient();
        if (!client) {
          setGenerationError("云端客户端不可用，上一个预览已保留。");
          setLastFailedRequest(request);
          setGenerationStep("保存失败");
          return;
        }
        try {
          savedVersion = await saveGeneration(client, {
            projectId: activeProjectId,
            prompt: request.prompt,
            app: payload.data,
            assistantMessage: assistantContent,
          });
          const savedProjects = await listProjects(client);
          setProjects(savedProjects);
          setActiveProjectId(savedVersion.project_id);
          setCurrentVersionId(savedVersion.version_id);
        } catch (error) {
          console.error("Generation persistence failed", error instanceof Error ? error.message : "unknown");
          setGenerationError("应用已生成，但云端保存失败；上一个预览已保留，可以重试。");
          setLastFailedRequest(request);
          setGenerationStep("保存失败");
          return;
        }
      }

      setResult(payload.data);
      setIsModelBacked(true);
      setLastFailedRequest(null);
      setPreviewKey((value) => value + 1);
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: assistantContent,
      }]);
      setGenerationStep(payload.meta.mode === "refine" ? "修改完成" : "生成完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : "生成失败，上一个预览已保留。";
      setGenerationError(message);
      setLastFailedRequest(request);
      setGenerationStep("生成失败");
    } finally {
      window.clearTimeout(stepTimer);
      setIsGenerating(false);
    }
  }

  async function handleGenerate(event?: FormEvent) {
    event?.preventDefault();
    const request = prompt.trim();
    if (request.length < 3 || isGenerating || persistenceStatus === "connecting") return;
    await runGeneration({ prompt: request, currentApp: isModelBacked ? result : undefined }, true);
  }

  async function copyCode() {
    await navigator.clipboard.writeText(result.html);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function startNewProject() {
    const fresh = generateDemoApp("创建一个简洁的产品灵感看板");
    setResult(fresh);
    setPreviewKey((value) => value + 1);
    setMessages([{ id: crypto.randomUUID(), role: "assistant", content: "新项目已创建。描述你想做的网页应用，我会从这里开始。" }]);
    setPrompt("");
    setIsModelBacked(false);
    setActiveProjectId(null);
    setCurrentVersionId(null);
    setHistoryOpen(false);
    setVersions([]);
    setGenerationError(null);
    setLastFailedRequest(null);
    setGenerationStep("等待你的想法");
  }

  async function selectProject(projectId: string) {
    if (projectId === activeProjectId || isGenerating) return;
    const client = getSupabaseClient();
    if (!client) return;

    setGenerationError(null);
    setGenerationStep("正在恢复项目");
    try {
      const loaded = await loadProject(client, projectId);
      setActiveProjectId(loaded.project.id);
      setCurrentVersionId(loaded.project.current_version_id);
      setMessages(loaded.messages.length ? loaded.messages : initialMessages);
      if (loaded.currentVersion) {
        setResult(loaded.currentVersion);
        setIsModelBacked(true);
        setPreviewKey((value) => value + 1);
      }
      setGenerationStep("已恢复云端项目");
    } catch (error) {
      console.error("Project loading failed", error instanceof Error ? error.message : "unknown");
      setGenerationError("项目恢复失败，请稍后重试。");
      setGenerationStep("恢复失败");
    }
  }

  async function openHistory() {
    if (!activeProjectId || persistenceStatus !== "ready") return;
    const client = getSupabaseClient();
    if (!client) return;

    setHistoryOpen(true);
    setIsHistoryLoading(true);
    setHistoryError(null);
    try {
      setVersions(await listVersions(client, activeProjectId));
    } catch (error) {
      console.error("Version loading failed", error instanceof Error ? error.message : "unknown");
      setHistoryError("历史版本加载失败，请稍后重试。");
    } finally {
      setIsHistoryLoading(false);
    }
  }

  async function handleRestore(version: PersistenceVersion) {
    if (!activeProjectId || restoringVersionId) return;
    const client = getSupabaseClient();
    if (!client) return;

    setRestoringVersionId(version.id);
    setHistoryError(null);
    try {
      const restored = await restoreVersion(client, activeProjectId, version.id);
      setResult({ title: restored.title, summary: restored.summary, html: restored.html });
      setCurrentVersionId(restored.version_id);
      setIsModelBacked(true);
      setPreviewKey((value) => value + 1);
      setMessages((current) => [...current, {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `已恢复到版本 ${restored.version_number}。`,
      }]);
      setProjects(await listProjects(client));
      setGenerationStep(`已恢复版本 ${restored.version_number}`);
    } catch (error) {
      console.error("Version restore failed", error instanceof Error ? error.message : "unknown");
      setHistoryError("版本恢复失败，请稍后重试。");
    } finally {
      setRestoringVersionId(null);
    }
  }

  const cloudLabel = persistenceStatus === "ready"
    ? "云端已同步"
    : persistenceStatus === "connecting"
      ? "正在连接云端"
      : persistenceStatus === "unconfigured"
        ? "等待 Supabase 配置"
        : "云端连接失败";
  const historyAvailable = persistenceStatus === "ready" && Boolean(activeProjectId && currentVersionId);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><div className="brand-name">ORBIT</div><div className="brand-caption">AI APP STUDIO</div></div>
        </div>
        <div className="project-heading">
          <span>{result.title}</span>
          <Badge className="local-badge">{isModelBacked ? "AI 已生成" : "示例预览"}</Badge>
        </div>
        <div className="top-actions">
          <Button
            variant="ghost"
            size="sm"
            className="history-button"
            disabled={!historyAvailable}
            title={historyAvailable ? "查看和恢复历史版本" : "生成并保存首个版本后开放"}
            onClick={openHistory}
          ><History size={16} />历史版本</Button>
          <Button size="sm" className="publish-button" disabled>发布<ExternalLink size={14} /></Button>
        </div>
      </header>

      <section className="workspace">
        <aside className="project-sidebar">
          <Button className="new-project" onClick={startNewProject} disabled={persistenceStatus === "connecting"}><Plus size={17} /><span>新建项目</span></Button>
          <div className="sidebar-label">最近项目</div>
          {!activeProjectId && (
            <div className="project-item active">
              <span className="project-icon"><Columns3 size={16} /></span>
              <span className="project-copy"><strong>{result.title}</strong><small>尚未保存</small></span>
              <MoreHorizontal size={16} />
            </div>
          )}
          {projects.map((project) => (
            <button
              type="button"
              key={project.id}
              className={`project-item ${project.id === activeProjectId ? "active" : ""}`}
              onClick={() => selectProject(project.id)}
              disabled={isGenerating}
            >
              <span className="project-icon"><Columns3 size={16} /></span>
              <span className="project-copy"><strong>{project.title}</strong><small>{formatVersionDate(project.updated_at)}</small></span>
              <MoreHorizontal size={16} />
            </button>
          ))}
          <div className="sidebar-spacer" />
          <div className="usage-card">
            <div className={`usage-icon ${persistenceStatus === "ready" ? "synced" : ""}`}>
              {persistenceStatus === "ready" ? <Cloud size={16} /> : <CloudOff size={16} />}
            </div>
            <div><strong>匿名工作区</strong><span>{cloudLabel}</span></div>
          </div>
        </aside>

        <section className="conversation-panel">
          <div className="panel-titlebar">
            <div><span className="eyebrow">BUILD SESSION</span><h1>把想法变成应用</h1></div>
            <div className={`session-status ${isGenerating ? "working" : generationError ? "error" : ""}`}>
              {isGenerating ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}{generationStep}
            </div>
          </div>

          <div className="mobile-projectbar">
            <select
              aria-label="选择项目"
              value={activeProjectId || "draft"}
              onChange={(event) => {
                if (event.target.value !== "draft") selectProject(event.target.value);
              }}
              disabled={isGenerating}
            >
              {!activeProjectId && <option value="draft">{result.title}（尚未保存）</option>}
              {projects.map((project) => <option value={project.id} key={project.id}>{project.title}</option>)}
            </select>
            <button type="button" onClick={startNewProject} disabled={persistenceStatus === "connecting"}><Plus size={15} />新建</button>
          </div>

          <ScrollArea className="message-scroll">
            <div className="messages">
              <div className="session-intro">
                <div className="intro-orbit"><WandSparkles size={21} /></div>
                <p>描述一个网页工具、数据看板或产品页面。</p>
                <span>请求会发送到服务端模型，生成结果通过安全校验后才会更新右侧预览。继续描述修改要求即可迭代当前应用。</span>
                <span className={`persistence-note ${persistenceStatus}`}>
                  {persistenceStatus === "ready" ? <Cloud size={13} /> : <CloudOff size={13} />}{cloudLabel}
                </span>
              </div>
              {messages.map((message) => (
                <div key={message.id} className={`message-row ${message.role}`}>
                  {message.role === "assistant" && <div className="assistant-avatar"><Sparkles size={15} /></div>}
                  <div className="message-bubble">{message.content}</div>
                </div>
              ))}
              {isGenerating && (
                <div className="message-row assistant">
                  <div className="assistant-avatar"><Sparkles size={15} /></div>
                  <div className="thinking-card">
                    <div className="thinking-head"><LoaderCircle size={16} className="spin" />{generationStep}</div>
                    <div className="thinking-line"><span /></div><div className="thinking-line short"><span /></div>
                  </div>
                </div>
              )}
              {generationError && !isGenerating && (
                <div className="generation-error" role="alert">
                  <AlertTriangle size={17} />
                  <div><strong>这次没有更新预览</strong><span>{generationError}</span></div>
                  {lastFailedRequest && <button type="button" onClick={() => runGeneration(lastFailedRequest, false)}>重试</button>}
                </div>
              )}
            </div>
          </ScrollArea>

          <div className="composer-wrap">
            <div className="prompt-suggestions">
              {samplePrompts.map((sample) => <button key={sample} onClick={() => setPrompt(sample)} disabled={isGenerating || persistenceStatus === "connecting"}>{sample}</button>)}
            </div>
            <form className="composer" onSubmit={handleGenerate}>
              <Textarea
                aria-label="描述你想生成的应用"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") handleGenerate();
                }}
                placeholder="例如：做一个客户管理看板，支持搜索和状态筛选…"
                disabled={isGenerating || persistenceStatus === "connecting"}
                maxLength={MAX_PROMPT_LENGTH}
              />
              <div className="composer-footer">
                <span>{prompt.length}/{MAX_PROMPT_LENGTH} · Ctrl + Enter 发送</span>
                <Button type="submit" size="icon" className="send-button" disabled={prompt.trim().length < 3 || isGenerating || persistenceStatus === "connecting"} aria-label="生成应用">
                  {isGenerating ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}
                </Button>
              </div>
            </form>
          </div>
        </section>

        <section className="preview-panel">
          <Tabs defaultValue="preview" className="preview-tabs">
            <div className="preview-toolbar">
              <TabsList className="view-tabs">
                <TabsTrigger value="preview"><Monitor size={15} />预览</TabsTrigger>
                <TabsTrigger value="code"><Code2 size={15} />代码</TabsTrigger>
              </TabsList>
              <div className="preview-tools">
                <div className="device-switcher">
                  <button className={viewport === "desktop" ? "active" : ""} onClick={() => setViewport("desktop")} aria-label="桌面预览"><Laptop size={15} /></button>
                  <button className={viewport === "mobile" ? "active" : ""} onClick={() => setViewport("mobile")} aria-label="手机预览"><Smartphone size={15} /></button>
                </div>
                <button className="tool-icon" aria-label="刷新预览" onClick={() => setPreviewKey((value) => value + 1)}><RefreshCw size={15} /></button>
              </div>
            </div>

            <TabsContent value="preview" className="preview-content">
              <div className={`browser-frame ${viewport}`}>
                <div className="browser-bar">
                  <div className="traffic-lights"><i /><i /><i /></div>
                  <div className="browser-address"><span className="address-lock" />preview.orbit.local</div>
                  <MoreHorizontal size={16} />
                </div>
                <div className="iframe-wrap">
                  <iframe key={previewKey} title={`${result.title} 预览`} srcDoc={result.html} sandbox="allow-scripts" />
                  {isGenerating && (
                    <div className="preview-generating">
                      <div className="generator-pulse"><WandSparkles size={22} /></div>
                      <strong>{generationStep}</strong><span>当前预览保持可用，完成后会自动更新</span>
                    </div>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="code" className="code-content">
              <div className="code-toolbar"><span>index.html</span><button onClick={copyCode}>{copied ? <Check size={15} /> : <Copy size={15} />}{copied ? "已复制" : "复制代码"}</button></div>
              <ScrollArea className="code-scroll"><pre><code>{result.html}</code></pre></ScrollArea>
            </TabsContent>
          </Tabs>
        </section>
      </section>
      {historyOpen && (
        <div className="history-backdrop" role="presentation">
          <section className="history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-title">
            <div className="history-head">
              <div><span className="eyebrow">VERSION HISTORY</span><h2 id="history-title">历史版本</h2></div>
              <button type="button" onClick={() => setHistoryOpen(false)} aria-label="关闭历史版本"><X size={18} /></button>
            </div>
            <div className="history-copy">每次成功生成都会保存为不可变版本。恢复只会切换当前版本，不会覆盖历史代码。</div>
            <div className="history-list">
              {isHistoryLoading && <div className="history-state"><LoaderCircle size={18} className="spin" />正在加载版本…</div>}
              {historyError && <div className="history-state error"><AlertTriangle size={17} />{historyError}</div>}
              {!isHistoryLoading && !historyError && versions.length === 0 && <div className="history-state">还没有可恢复的版本。</div>}
              {versions.map((version) => {
                const isCurrent = version.id === currentVersionId;
                return (
                  <article key={version.id} className={`version-card ${isCurrent ? "current" : ""}`}>
                    <div className="version-meta">
                      <strong>版本 {version.version_number}</strong>
                      <span>{formatVersionDate(version.created_at)}</span>
                    </div>
                    <h3>{version.title}</h3>
                    <p>{version.summary}</p>
                    <div className="version-actions">
                      {isCurrent && <Badge className="current-version-badge">当前版本</Badge>}
                      <button
                        type="button"
                        disabled={isCurrent || Boolean(restoringVersionId)}
                        onClick={() => handleRestore(version)}
                      >
                        {restoringVersionId === version.id ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}
                        {restoringVersionId === version.id ? "恢复中" : "恢复此版本"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
