# ابزارها و روش‌های اتوماسیون ایجنت‌های هوش مصنوعی

> تاریخ گردآوری: مهر ۱۴۰۵ (اکتبر ۲۰۲۶)

## ۱. روش‌ها (الگوهای معماری)

| روش | توضیح | کاربرد مناسب |
|---|---|---|
| **حلقه‌ی ایجنتی (Agent Loop / ReAct)** | مدل فکر می‌کند ← ابزار صدا می‌زند ← نتیجه را می‌بیند ← تکرار تا پایان کار | کارهای باز و چندمرحله‌ای |
| **Tool Calling / Function Calling** | تعریف ابزار با JSON Schema تا مدل بتواند API، دیتابیس و فایل را صدا بزند | پایه‌ی تقریباً همه‌ی ایجنت‌ها |
| **MCP (Model Context Protocol)** | پروتکل استاندارد برای وصل کردن ابزارها و داده‌ها به هر ایجنت؛ یک‌بار بنویس، همه‌جا استفاده کن | اتصال به Slack، GitHub، دیتابیس و … |
| **Workflow ثابت (Prompt Chaining / Routing)** | مراحل از پیش تعیین‌شده؛ LLM فقط در گره‌های مشخص تصمیم می‌گیرد | فرایندهای تکراری و قابل پیش‌بینی |
| **گراف حالت (State Graph)** | جریان کار به‌صورت گره و یال با حالت پایدار، شاخه، حلقه و بازگشت | فرایندهای پیچیده‌ی تولیدی |
| **چندایجنتی (Multi-Agent)** | یک هماهنگ‌کننده (Orchestrator) کار را بین ایجنت‌های متخصص تقسیم می‌کند | پژوهش، تولید محتوا، کدنویسی |
| **RAG و حافظه** | بازیابی اسناد از پایگاه برداری + حافظه‌ی کوتاه/بلندمدت | پاسخ بر اساس دانش سازمانی |
| **Human-in-the-loop** | توقف برای تأیید انسان پیش از اقدامات حساس | پرداخت، ارسال ایمیل، دیپلوی |
| **زمان‌بندی و رویدادمحوری** | اجرای ایجنت با Cron، Webhook یا رویداد (مثلاً PR جدید، ایمیل جدید) | اتوماسیون کامل بدون دخالت دستی |
| **Computer/Browser Use** | ایجنت صفحه را می‌بیند و کلیک/تایپ می‌کند | سیستم‌هایی که API ندارند |

## ۲. ابزارها

### الف) فریم‌ورک‌های کدنویسی (برای توسعه‌دهندگان)

| ابزار | زبان | نقطه‌ی قوت |
|---|---|---|
| **LangGraph** | Python / JS | گراف حالت، پایداری، human-in-the-loop؛ مناسب تولید |
| **LangChain** | Python / JS | اکوسیستم بزرگ، RAG، اتصال به مدل‌های مختلف |
| **CrewAI** | Python | چندایجنتی نقش‌محور (پژوهشگر، نویسنده، …)؛ نمونه‌سازی سریع |
| **Microsoft AutoGen / Agent Framework** | Python / .NET | گفت‌وگوی چندایجنتی، یکپارچه با Azure |
| **OpenAI Agents SDK / Responses API** | Python / JS | ساده، handoff بین ایجنت‌ها، guardrail |
| **Claude Agent SDK** | Python / TS | همان هسته‌ی Claude Code: ابزار فایل/ترمینال، MCP، زیرایجنت، hook |
| **Google ADK** | Python / Java | ایجنت‌های چندگانه روی Vertex AI / Gemini |
| **LlamaIndex** | Python / TS | ایجنت‌های داده‌محور و RAG |
| **Mastra** | TypeScript | فریم‌ورک فول‌استک TS: workflow، حافظه، eval |
| **Pydantic AI** | Python | خروجی ساخت‌یافته و type-safe |
| **Haystack / Semantic Kernel / smolagents** | Python / .NET | خط‌لوله‌ی جست‌وجو، سازمانی، ایجنت‌های سبک کدنویس |

### ب) پلتفرم‌های No-code / Low-code

| ابزار | ویژگی |
|---|---|
| **n8n** | متن‌باز و قابل نصب روی سرور شخصی؛ نسخه‌ی ۲ با گره‌های AI، حافظه‌ی پایدار، LangChain داخلی و مرحله‌ی تأیید انسانی |
| **Zapier (Agents)** | ساده‌ترین شروع، بیش از ۸۰۰۰ اپ؛ هزینه بر اساس هر task |
| **Make (+ Maia)** | میان سادگی Zapier و قدرت n8n؛ ساخت سناریو با زبان طبیعی |
| **Gumloop / Lindy / Relevance AI** | ساخت ایجنت بدون کد برای کارهای کسب‌وکاری |
| **Dify / Flowise / Langflow** | ساخت بصری اپ‌ها و ایجنت‌های LLM، متن‌باز |
| **Botpress / Voiceflow** | ایجنت‌های گفت‌وگو و چت‌بات |

### ج) پلتفرم‌های ابری سازمانی

- **AWS Bedrock AgentCore** — اجرا، حافظه و هویت ایجنت‌ها روی AWS
- **Google Vertex AI Agent Builder** — همراه با ADK
- **Microsoft Copilot Studio + Azure AI Foundry** — برای محیط M365
- **Claude Managed Agents / OpenAI Assistants** — ایجنت میزبانی‌شده با sandbox مدیریت‌شده

### د) ایجنت‌های کدنویسی و اتوماسیون توسعه

- **Claude Code** (CLI، وب، GitHub Actions، Routineهای زمان‌بندی‌شده)، **OpenAI Codex**، **GitHub Copilot Agent**، **Cursor**، **Devin**، **Aider**
- اتوماسیون: اجرای خودکار روی Issue/PR، رفع CI، بررسی کد، اجرای دوره‌ای

### هـ) اتوماسیون مرورگر و رایانه

- **Browser Use**، **Playwright / Puppeteer** همراه LLM، **Stagehand**، **Skyvern**
- **Computer Use** (Anthropic)، **OpenAI Operator / CUA**

### و) زیرساخت جانبی

| دسته | ابزارها |
|---|---|
| مشاهده‌پذیری و ارزیابی | LangSmith، Langfuse، Arize Phoenix، Braintrust، Weights & Biases Weave |
| اجرای پایدار و زمان‌بندی | Temporal، Inngest، Trigger.dev، Prefect، Airflow، Cron / GitHub Actions |
| پایگاه برداری و حافظه | Pinecone، Weaviate، Qdrant، Chroma، pgvector، Mem0، Zep |
| Sandbox اجرای کد | E2B، Modal، Daytona، Docker |
| پروتکل‌ها | MCP (اتصال ابزار)، A2A (ارتباط ایجنت با ایجنت) |

## ۳. راهنمای انتخاب

1. **بدون کدنویسی و سریع** ← Zapier یا Make؛ اگر داده‌ها حساس است یا هزینه مهم است ← n8n روی سرور خودتان.
2. **برنامه‌نویس هستید و فرایند پیچیده دارید** ← LangGraph (پایتون) یا Mastra (تایپ‌اسکریپت).
3. **چند ایجنت با نقش‌های مشخص** ← CrewAI یا AutoGen.
4. **ایجنتی که با فایل، ترمینال و کد کار کند** ← Claude Agent SDK یا Claude Code.
5. **سازمان روی یک ابر خاص است** ← Bedrock AgentCore / Vertex AI / Copilot Studio.
6. در هر حالت: ابزارها را با **MCP** وصل کنید، با **Langfuse/LangSmith** پایش کنید و برای اقدامات حساس **تأیید انسانی** بگذارید.

## ۴. نکات کلیدی

- از ساده‌ترین راه‌حل شروع کنید: یک workflow ثابت اغلب از یک ایجنت کاملاً خودمختار قابل‌اعتمادتر و ارزان‌تر است.
- ابزارها را کم، دقیق و با توضیحات روشن تعریف کنید.
- مجموعه‌ی آزمون (eval) بسازید و رفتار ایجنت را مرتب بسنجید.
- محدودیت دسترسی، sandbox و لاگ کامل برای امنیت و جلوگیری از prompt injection ضروری است.

## منابع

- [LangChain — The best AI agent frameworks in 2026](https://www.langchain.com/resources/ai-agent-frameworks)
- [Firecrawl — Best open source frameworks for building AI agents in 2026](https://www.firecrawl.dev/blog/best-open-source-agent-frameworks)
- [Gumloop — 6 best AI agent frameworks in 2026](https://www.gumloop.com/blog/ai-agent-frameworks)
- [Hostkey — Best Agentic AI Frameworks in 2026](https://hostkey.com/blog/195-best-ai-agent-frameworks-in-2026-a-practical-guide-for-developers-and-infrastructure-teams/)
- [Alice Labs — Best AI Agent Frameworks 2026](https://alicelabs.ai/en/insights/best-ai-agent-frameworks-2026)
- [DEV Community — n8n vs Zapier vs Make (2026)](https://dev.to/lusivision/ai-workflow-automation-2026-n8n-vs-zapier-vs-make-ppg)
- [Hatchworks — n8n vs Zapier 2026](https://hatchworks.com/blog/ai-agents/n8n-vs-zapier/)
- [IntuitionLabs — Zapier vs n8n for AI Workflows](https://intuitionlabs.ai/articles/zapier-vs-n8n-ai-workflows)
