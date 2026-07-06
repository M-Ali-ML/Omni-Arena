### Persona 1: The End User (Arena Voter)
**Story 1: Anonymous Dual-Stream Chat**
**As an end user**, I want to submit a prompt and receive concurrent responses from two anonymous models side-by-side, **so that** I can compare their outputs in real-time without bias.
*   **Acceptance Criteria:**
    *   The backend utilizes a "Unified Arena Core" router that fires parallel requests to two distinct models.
    *   Tokens stream to the UI simultaneously using multiplexed Server-Sent Events (SSE) or WebSockets.
    *   Model selection relies on randomized "King of the Hill" logic to assign models to slot A or B, preventing positional bias.
    *   Model identities remain strictly hidden (blind A/B testing) until a vote is successfully submitted.

**Story 2: Submitting a Preference Vote**
**As an end user**, I want to vote on which model provided the better response (or declare a tie), **so that** my human preference is recorded.
*   **Acceptance Criteria:**
    *   The UI provides clear voting options: "left preferred," "right preferred," "both good" (tie), "both bad," and "skip".
    *   Upon voting, the system reveals the true identities of the models in slot A and slot B.
    *   The backend validates the vote using cryptographic tokens or short-lived cache checks to prevent users from cheating, manipulating votes, or sniffing network traffic to see model names prematurely.

**Story 3: Multi-Turn Conversations (Linear History)**
**As an end user**, I want to continue my conversation with the models after voting on the first turn, **so that** I can evaluate them on complex, multi-step tasks.
*   **Acceptance Criteria:**
    *   The system enforces a "Linear History Policy".
    *   When the user submits a follow-up prompt, the conversation context tree continues *only* from the response ID that the user just voted as the winner, keeping the chat history linear and clean.

### Persona 2: The LLM App Developer (Integrator)
**Story 4: Drop-In Frontend Integration**
**As an app developer**, I want to use a simple frontend SDK or hook, **so that** I can add an "Arena Mode" to my existing chat app without writing complex multi-stream backend logic.
*   **Acceptance Criteria:**
    *   The service provides a custom drop-in React/Vue hook (e.g., `useArenaChat`).
    *   The hook natively manages dual-stream UI rendering states and captures votes in less than ten lines of code.

**Story 5: Protocol-Agnostic Backend Connection**
**As an app developer**, I want the OmniArena backend to support industry-standard streaming protocols, **so that** it easily snaps into my existing infrastructure.
*   **Acceptance Criteria:**
    *   The service routes internal events through standard Protocol Adapters.
    *   It supports the **Vercel AI SDK**, multiplexing the second model inside sidecar data packets while passing the first model through the main text channel.
    *   It supports the **OpenAI SSE Standard**, mapping dual streams into classic OpenAI chat completions endpoints for apps built around OpenAI or Ollama.
    *   It supports **AG-UI** and **A2UI** protocols for evaluating models that generate structured UI components or agentic tool calls.

### Persona 3: The AI Developer (Evaluator)
**Story 6: Real-Time Leaderboard & Elo Tracking**
**As an AI developer**, I want to view a continuously updated leaderboard based on human votes, **so that** I can accurately benchmark my internal model checkpoints against state-of-the-art baselines.
*   **Acceptance Criteria:**
    *   The evaluation engine stores matchup and preference data in an independent datastore.
    *   Model strengths are calculated using the Bradley-Terry (BT) model via Maximum Likelihood Estimation.
    *   The calculations are highly optimized (utilizing vectorized preprocessing and multinomial bootstrapping) to ensure the leaderboard updates rapidly.

**Story 7: Style-Controlled Evaluation**
**As an AI developer**, I want the ranking engine to filter out superficial biases in user voting, **so that** the leaderboard reflects true model reasoning and capabilities.
*   **Acceptance Criteria:**
    *   The rating calculations apply regression to control for stylistic confounders.
    *   Specific factors controlled include token count differences (verbosity bias), markdown formatting density (headers, bold text, lists), and loading time/latency differences.