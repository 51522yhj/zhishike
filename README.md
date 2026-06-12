# 知时客

知时客是一款 Electron + React + TypeScript 构建的实时知识桌面助手。它可以导入个人简历、项目资料和企业资料，在答题、会议、面试等场景中结合知识库、屏幕内容和语音转写生成可直接使用的回答建议。

## 示例图

![实时辅助](docs/images/screenshot-01.png)
![知识库](docs/images/screenshot-02.png)
![隐私设置](docs/images/screenshot-03.png)
![模型设置](docs/images/screenshot-04.png)
![悬浮建议条](docs/images/screenshot-05.png)
![会议记录](docs/images/screenshot-06.png)
![托盘菜单](docs/images/screenshot-07.png)
![面试模式](docs/images/screenshot-08.png)
![个人提示词](docs/images/screenshot-09.png)

## 主要功能

- 实时辅助：根据当前窗口、会议字幕、语音转写和知识库生成回答建议。
- 本地知识库：支持导入 PDF、DOCX、Markdown、TXT，按简历、项目、企业/课程资料分类。
- 个人资料提示词：在知识库页补充个人背景和回答偏好，让 AI 回答更贴合你的经历。
- 答题模式：识别屏幕题目，结合视觉模型和知识库生成解题思路或答案。
- 会议模式：转写会议音频，提炼重点、待办和可复述的回复。
- 面试模式：识别面试官问题，按候选人口吻生成自然回答。
- 悬浮建议条：可在桌面上显示简洁建议，并支持拖动、暂停、继续和结束当前会议/面试。
- 隐私控制：支持暂停监控、黑名单、活动窗口监控、视觉理解开关和悬浮条样式配置。
- 本地记录：配置、知识库索引、会话记录等保存在本机，便于备份和排查。

## 环境要求

- Node.js 20 或更高版本
- Windows 10/11
- 可选：支持 OpenAI-compatible API 的大语言模型服务
- 可选：支持图像输入的 VL/vision 模型，用于答题模式和屏幕理解
- 可选：讯飞语音听写/实时语音转写密钥，用于会议/面试语音转写

## 安装与运行

```powershell
git clone https://github.com/51522yhj/zhishike.git
cd zhishike
npm install
npm run dev
```

构建生产版本：

```powershell
npm run build
```

打包 Windows 可运行目录：

```powershell
npm run dist:win
```

打包后可执行文件位于：

```text
release/zhishike-win32-x64/知时客.exe
```

## 基本使用

1. 打开应用后进入“模型”页，填写通用模型的 Base URL、API Key 和模型名。
2. 如果需要答题模式或屏幕理解，填写支持图片输入的视觉模型配置。
3. 如果需要会议/面试转写，开启语音转写并填写对应服务密钥。
4. 进入“知识库”页，选择资料分类并导入简历、项目文档或企业资料。
5. 在“个人资料提示词”中补充你的个人背景、项目职责、技术栈、回答风格和希望强调的内容。
6. 回到“助手”页，点击“生成建议”，或在隐私页切换答题、会议、面试模式。
7. 会议或面试过程中，可以随时点击顶部按钮结束当前会议或面试。

## 模型配置说明

### 通用对话模型

用于实时辅助、知识库问答、会议总结、面试回答等文字生成。

需要填写：

- Base URL：OpenAI-compatible API 地址，例如 `https://api.openai.com/v1`
- API Key：模型服务密钥
- Chat Model：模型名称，例如 `gpt-4o-mini`、`qwen-plus`、`deepseek-chat`

环境变量示例：

```powershell
$env:OPENAI_API_KEY="你的 API Key"
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_CHAT_MODEL="gpt-4o-mini"
npm run dev
```

### 视觉模型

用于答题模式和屏幕视觉理解。必须选择支持图片输入的 VL/vision 模型，不要填写图片生成模型。

常见示例：

- OpenAI：`gpt-4o`、`gpt-4.1`
- 阿里云百炼：`qwen-vl-plus-latest`
- 其他 OpenAI-compatible 视觉模型

### 语音转写模型

用于会议模式和面试模式。

当前支持：

- OpenAI-compatible `/audio/transcriptions`
- 讯飞语音听写/实时语音转写

讯飞配置需要填写：

- APPID
- APIKey
- APISecret
- Endpoint
- 语言
- 领域

注意：讯飞“模型服务列表”中的 MaaS 推理服务和“语音听写/实时语音转写”不是同一个授权服务。请使用语音服务页提供的密钥。

## 各模式需要的模型

| 模式 | 必需模型 | 可选模型 | 说明 |
| --- | --- | --- | --- |
| 实时辅助 | 通用对话模型 | 视觉模型 | 有视觉模型时可结合屏幕截图理解当前工作。 |
| 答题模式 | 视觉模型 | 通用对话模型、知识库 | 需要看图识别题目，建议配置 VL/vision 模型。 |
| 会议模式 | 语音转写模型、通用对话模型 | 知识库 | 用于会议语音转写、总结和生成可回复内容。 |
| 面试模式 | 语音转写模型、通用对话模型 | 知识库、个人资料提示词 | 根据面试官问题生成候选人口吻回答。 |
| 知识库问答 | 通用对话模型 | 个人资料提示词 | 导入资料越完整，回答越贴合个人经历。 |

## 存储位置

### Windows

```text
C:\zhishike\records\assistant-db.json
C:\zhishike\records\runtime.log
C:\zhishike\screenshots\
```

### macOS

```text
~/Documents/zhishike/records/assistant-db.json
~/Documents/zhishike/records/runtime.log
~/Documents/zhishike/screenshots/
```

### Linux

```text
~/zhishike/records/assistant-db.json
~/zhishike/records/runtime.log
~/zhishike/screenshots/
```

`assistant-db.json` 中保存知识库索引、模型配置、隐私设置、会话记录、个人资料提示词等数据。请不要把包含真实密钥的本地数据上传到公开仓库。

## 快捷键

- `Ctrl+Shift+Space`：显示/隐藏助手窗口
- `Ctrl+Shift+P`：暂停/继续监控
- `Ctrl+Shift+S`：跳转到实时辅助视图

## 开发脚本

```powershell
npm run dev        # 开发模式
npm run typecheck  # TypeScript 类型检查
npm run build      # 构建主进程和渲染进程
npm run dist:win   # 打包 Windows 可运行目录
```

## 项目结构

```text
src/main/       Electron 主进程、窗口、托盘、截图、存储、AI 调用
src/preload/    Electron preload API
src/renderer/   React 界面
src/shared/     前后端共享类型
src/assets/     应用图标与视觉资源
docs/images/    README 示例图
scripts/        打包脚本
```

## 隐私提醒

本项目会根据配置读取活动窗口、屏幕截图或音频流，并可能发送给你配置的模型服务。使用前请确认：

- 已了解模型服务的数据处理规则。
- 不在敏感场景开启截图或语音转写。
- 不把本地 `C:\zhishike` 或 `~/Documents/zhishike` 中包含密钥的数据提交到公开仓库。
