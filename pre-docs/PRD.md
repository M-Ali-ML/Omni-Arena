**Product Requirements Document (PRD): OmniArena**

**1. Product Overview**
**OmniArena** is a standalone, framework-agnostic microservice designed to integrate pairwise LLM evaluation (an "Arena Mode") into any existing chat application. It enables development teams to effortlessly A/B test their own internal model checkpoints against each other or compare them with external state-of-the-art models by capturing non-opinionated human preference signals in real-time.

**2. Target Audience & Use Cases**
*   **AI Development Teams:** Needs to evaluate newly trained model checkpoints (e.g., from scratch or fine-tunes) against baseline models using live human interactions.
*   **LLM App Developers:** Wants to implement a plug-and-play side-by-side model comparison feature in their frontends (via drop-in components) without building complex multi-stream backend logic.

**3. Core Architecture & Infrastructure**
*   **Independent Preference Datastore:** The service must have its own database to decouple evaluation logic from the host app's presentation layer. Required tables include:
    *   *Models:* `model_id`, `provider`, `capabilities`, `current_elo`.
    *   *Matchups:* `matchup_id`, `model_a`, `model_b`, `prompt_id`, `timestamp`.
    *   *Preferences:* `vote_id`, `matchup_id`, `winner_id`, `position_bias_meta`.
*   **Unified Arena Core Router:** The backend must avoid protocol-specific execution logic. Instead, it should act as a central router that fires parallel requests to two models and treats incoming text tokens as internal events.
*   **Resiliency Guardrails:** The stream orchestrator must handle partial failures gracefully; for example, if Model B times out or throws an error, the system must alert the client without crashing Model A's stream.

**4. Stream Orchestration & Protocol Adapters**
To remain fully pluggable, the internal events must be piped through standard protocol adapters:
*   **Multiplexed SSE & WebSockets:** Provide a custom Server-Sent Events (SSE) layer that wraps text chunks in payloads identifying their stream origin (e.g., `data: {"slot": "A", "token": "Hello"}`) to deliver concurrent responses. A WebSocket connection should be supported as a control plane for mid-stream user steering or stopping generation.
*   **Vercel AI SDK Adapter:** Essential for seamless integration into React, Vue, and Next.js apps. It will use the Custom Stream Data primitive to multiplex the second model inside sidecar data packets alongside the main text channel.
*   **AG-UI Adapter:** Supports typed events (e.g., `TEXT_MESSAGE_CONTENT`, `TOOL_CALL_START`) for rich agent-to-user interaction streams.
*   **OpenAI SSE Standard:** A lightweight adapter mapping dual streams into classic OpenAI chat completions endpoints to support apps built for OpenAI or Ollama.
*   **A2UI Support:** To evaluate how models generate structured layouts or generative UI components, this spec streams schema-validated JSON describing UI elements safely.

**5. Matchmaking & User Experience (UX)**
*   **Blind A/B Randomization:** Model selection must use "King of the Hill" logic for randomized slot assignments (A or B) to prevent positional bias. Model identities must be strictly hidden until the user successfully submits a vote.
*   **Smart Sampling:** The matchmaking engine should sample model pairs dynamically, prioritizing under-evaluated pairs or those with high variance to maximize statistical sample efficiency. Out-of-flow models can be randomly matched against an in-flow model already engaged in a conversation.
*   **Voting Mechanisms:** Users must be able to vote for their preferred response or indicate a tie. Supported options should include: "left preferred," "right preferred," "both good" (tie), "both bad," and "skip". 
*   **Linear History Policy:** For multi-turn conversations, the system must enforce a policy where all subsequent turns stem only from the winning response ID, keeping the context tree linear.
*   **Frontend SDK:** Provide a drop-in custom React/Vue hook (e.g., `useArenaChat`) that developers can use to render the dual streams and capture votes natively in less than ten lines of code.
*   **Multimodal Capabilities:** Ensure the arena supports image inputs so that vision-language models can be evaluated side-by-side on tasks like captioning, document understanding, and math.

**6. Elo Rating & Evaluation Engine**
*   **Bradley-Terry (BT) Model:** The system will calculate relative model strength scores using the Bradley-Terry model via Maximum Likelihood Estimation. 
*   **Style-Controlled Rankings:** To ensure the rankings reflect true capabilities rather than superficial presentation, the engine must use regression to control for stylistic confounders such as:
    *   *Token count difference (verbosity bias)*.
    *   *Markdown formatting density*.
    *   *Loading time / latency differences*.
*   **High-Speed Optimization:** The rating calculations must be highly optimized using vectorized preprocessing, multiprocessing, and multinomial bootstrapping (sampling from unique count distributions) to ensure the leaderboard updates rapidly.
*   **Anomaly Detection:** Implement mechanisms to detect abnormal user behavior (e.g., spamming repetitive inputs or meaningless text) using p-value testing to exclude malicious votes from the final Elo calculations.

**7. Security & Integrity**
*   **Anti-Cheat Masking:** Ensure that users cannot manipulate votes or peek at model identities prematurely via network sniffing. The backend must enforce matchup integrity using cryptographic tokens or short-lived cache checks.
*   **Data De-Identification:** Implement automated PII-scrubbing to ensure that logged chat histories are de-identified before being stored or analyzed for leaderboard updates.