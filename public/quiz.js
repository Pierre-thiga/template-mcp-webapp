// Client du quiz : rendu, navigation, timer et autosave. Vanilla JS, sans build.
"use strict";

(() => {
  const initial = JSON.parse(document.getElementById("quiz-data").textContent);
  const quiz = initial.quiz;
  const clockOffset = Date.parse(initial.server_now) - Date.now();
  const total = quiz.questions.length;
  const CONFIDENCE = [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ];

  let current = indexFromHash() ?? 0;
  const app = document.getElementById("app");

  // ---------- Helpers ----------

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      if (key === "class") el.className = value;
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else if (key === "text") el.textContent = value;
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  const readOnly = () => quiz.status !== "open";
  const question = () => quiz.questions[current];
  const answeredCount = () => quiz.questions.filter((q) => q.response.selected !== null).length;
  const now = () => Date.now() + clockOffset;

  function indexFromHash() {
    const n = Number(location.hash.slice(1));
    return Number.isInteger(n) && n >= 1 && n <= total ? n - 1 : null;
  }

  function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const seconds = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
  }

  // ---------- Autosave ----------

  const pending = new Map(); // numéro de question -> patch fusionné, pas encore envoyé
  let inFlight = false;
  let retryDelay = 0;
  let retryTimer = null;
  let commentTimer = null;
  let saveState = "saved"; // saved | saving | retrying | error | locked

  function setSaveState(state) {
    saveState = state;
    const el = document.getElementById("save-state");
    if (!el) return;
    const labels = {
      saved: "All changes saved",
      saving: "Saving…",
      retrying: "Not saved, retrying…",
      error: "Save failed",
      locked: "Read-only",
    };
    el.textContent = labels[state];
    el.dataset.state = state;
  }

  function queue(number, patch) {
    pending.set(number, { ...pending.get(number), ...patch });
    setSaveState("saving");
    flush();
  }

  async function flush() {
    if (inFlight || retryTimer || pending.size === 0) return;
    const [number, patch] = pending.entries().next().value;
    pending.delete(number);
    inFlight = true;
    let rejected = false;
    try {
      const res = await fetch(`/q/${quiz.id}/responses/${number}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        pending.clear();
        lock(body.status ?? "closed");
        return;
      }
      if (res.status === 400 || res.status === 404) {
        // Patch refusé : inutile de le renvoyer.
        console.error("Rejected save", await res.text());
        rejected = true;
      } else if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      } else {
        retryDelay = 0;
      }
    } catch (err) {
      // Erreur réseau ou serveur : on remet le patch en tête (sans écraser un patch plus récent) et on réessaie.
      pending.set(number, { ...patch, ...pending.get(number) });
      retryDelay = Math.min(retryDelay ? retryDelay * 2 : 1000, 15000);
      setSaveState("retrying");
      retryTimer = setTimeout(() => {
        retryTimer = null;
        flush();
      }, retryDelay);
      console.error("Save failed", err);
    } finally {
      inFlight = false;
    }
    if (pending.size) flush();
    else if (rejected) setSaveState("error");
    else if (!retryTimer && !commentTimer) setSaveState("saved");
  }

  function flushComment() {
    if (commentTimer) {
      clearTimeout(commentTimer.id);
      queue(commentTimer.number, { comment: commentTimer.value });
      commentTimer = null;
    }
  }

  // Attend que tout soit envoyé (utilisé avant la validation).
  async function drain(timeoutMs = 10000) {
    flushComment();
    const deadline = Date.now() + timeoutMs;
    while ((pending.size || inFlight) && Date.now() < deadline && !readOnly()) {
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
        flush();
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return pending.size === 0 && !inFlight;
  }

  function update(patch) {
    if (readOnly()) return;
    const q = question();
    Object.assign(q.response, patch);
    queue(q.number, patch);
    render();
  }

  function lock(status) {
    quiz.status = status;
    if (status === "submitted" && !quiz.submitted_at) quiz.submitted_at = new Date(now()).toISOString();
    if (status === "closed" && !quiz.closed_at) quiz.closed_at = new Date(now()).toISOString();
    setSaveState("locked");
    render();
  }

  // ---------- Actions ----------

  function select(letter) {
    update({ selected: question().response.selected === letter ? null : letter });
  }

  function toggleStrike(letter) {
    const struck = question().response.struck;
    update({ struck: struck.includes(letter) ? struck.filter((l) => l !== letter) : [...struck, letter].sort() });
  }

  function setConfidence(value) {
    update({ confidence: question().response.confidence === value ? null : value });
  }

  function goTo(index) {
    if (index < 0 || index >= total || index === current) return;
    flushComment();
    current = index;
    history.replaceState(null, "", `#${current + 1}`);
    render({ resetFocus: true });
  }

  // ---------- Rendering ----------

  function renderHeader() {
    return h(
      "header",
      { class: "topbar" },
      h(
        "div",
        { class: "title" },
        h("h1", { text: quiz.name }),
        h("span", { class: "run", text: `Run ${quiz.run_id}` }),
      ),
      h(
        "div",
        { class: "stats" },
        h("span", { class: "progress", text: `${answeredCount()} / ${total} answered` }),
        h("span", { id: "save-state", class: "save-state", "data-state": saveState }),
        h("span", { id: "timer", class: "timer", role: "timer", "aria-live": "off" }),
      ),
    );
  }

  function renderBanner() {
    if (quiz.status === "submitted") {
      const at = new Date(quiz.submitted_at).toLocaleString("en-GB");
      return h(
        "div",
        { class: "banner banner-done", role: "status" },
        h("strong", { text: "Answers submitted. " }),
        `Submitted on ${at}. You can review your answers below or close this page.`,
      );
    }
    if (quiz.status === "closed") {
      return h(
        "div",
        { class: "banner banner-closed", role: "status" },
        h("strong", { text: "This quiz is closed. " }),
        "It no longer accepts changes.",
      );
    }
    return null;
  }

  function renderQuestion() {
    const q = question();
    const r = q.response;
    const disabled = readOnly();

    const choices = h(
      "div",
      { class: "choices", role: "radiogroup", "aria-label": `Options for question ${q.number}` },
      q.choices.map((c) => {
        const isSelected = r.selected === c.letter;
        const isStruck = r.struck.includes(c.letter);
        return h(
          "div",
          { class: `choice${isSelected ? " selected" : ""}${isStruck ? " struck" : ""}` },
          h(
            "button",
            {
              type: "button",
              class: "choice-main",
              role: "radio",
              "aria-checked": String(isSelected),
              "data-key": `choice-${c.letter}`,
              disabled,
              onclick: () => select(c.letter),
              oncontextmenu: (e) => {
                e.preventDefault();
                toggleStrike(c.letter);
              },
            },
            h("span", { class: "letter", text: c.letter }),
            h("span", { class: "choice-text", text: c.text }),
          ),
          h(
            "button",
            {
              type: "button",
              class: "strike-btn",
              "aria-pressed": String(isStruck),
              "aria-label": `${isStruck ? "Restore" : "Cross out"} option ${c.letter}`,
              title: `${isStruck ? "Restore" : "Cross out"} option ${c.letter} (Shift+${c.letter} or right-click)`,
              "data-key": `strike-${c.letter}`,
              disabled,
              onclick: () => toggleStrike(c.letter),
            },
            h("span", { class: "strike-icon", "aria-hidden": "true", text: "abc" }),
          ),
        );
      }),
    );

    const confidence = h(
      "fieldset",
      { class: "confidence" },
      h("legend", { text: "Confidence" }),
      h(
        "div",
        { class: "segmented" },
        CONFIDENCE.map((c) =>
          h("button", {
            type: "button",
            class: `seg seg-${c.value}`,
            "aria-pressed": String(r.confidence === c.value),
            "data-key": `confidence-${c.value}`,
            disabled,
            onclick: () => setConfidence(c.value),
            text: c.label,
          }),
        ),
      ),
    );

    const comment = h("textarea", {
      id: "comment",
      rows: "3",
      maxlength: "5000",
      placeholder: disabled ? "" : "Notes for this question (optional)",
      readonly: disabled,
      "data-key": "comment",
      oninput: (e) => {
        const value = e.target.value;
        r.comment = value;
        if (commentTimer) clearTimeout(commentTimer.id);
        const number = q.number;
        commentTimer = {
          number,
          value,
          id: setTimeout(() => {
            commentTimer = null;
            queue(number, { comment: value });
          }, 500),
        };
        setSaveState("saving");
      },
      onblur: flushComment,
    });
    comment.value = r.comment;

    const nav = h(
      "nav",
      { class: "nav", "aria-label": "Question navigation" },
      h("button", { type: "button", "data-key": "nav-first", disabled: current === 0, onclick: () => goTo(0), text: "« First" }),
      h("button", { type: "button", "data-key": "nav-prev", disabled: current === 0, onclick: () => goTo(current - 1), text: "‹ Previous" }),
      h("button", { type: "button", class: "primary", "data-key": "nav-next", disabled: current === total - 1, onclick: () => goTo(current + 1), text: "Next ›" }),
      h("button", { type: "button", "data-key": "nav-last", disabled: current === total - 1, onclick: () => goTo(total - 1), text: "Last »" }),
    );

    return h(
      "section",
      { class: "question-panel", "aria-labelledby": "q-title" },
      h(
        "div",
        { class: "q-head" },
        h("h2", { id: "q-title", tabindex: "-1", text: `Question ${q.number} of ${total}` }),
        h(
          "button",
          {
            type: "button",
            class: `bookmark${r.bookmarked ? " on" : ""}`,
            "aria-pressed": String(r.bookmarked),
            "data-key": "bookmark",
            disabled,
            onclick: () => update({ bookmarked: !r.bookmarked }),
          },
          h("span", { "aria-hidden": "true", text: r.bookmarked ? "★ " : "☆ " }),
          r.bookmarked ? "Bookmarked" : "Bookmark",
        ),
      ),
      h("p", { class: "q-text", text: q.text }),
      choices,
      h("div", { class: "extras" }, confidence, h("div", { class: "comment" }, h("label", { for: "comment", text: "Comment" }), comment)),
      nav,
      disabled ? null : h("p", { class: "hint", text: "Keys: ← → to navigate · A–Z to select · Shift+letter to cross out" }),
    );
  }

  function renderPalette() {
    const grid = h(
      "div",
      { class: "grid" },
      quiz.questions.map((q, i) => {
        const states = [];
        if (q.response.selected) states.push("answered");
        else states.push("not answered");
        if (q.response.bookmarked) states.push("bookmarked");
        return h("button", {
          type: "button",
          class: [
            "cell",
            q.response.selected ? "answered" : "",
            q.response.bookmarked ? "bookmarked" : "",
            i === current ? "current" : "",
          ].join(" "),
          "aria-current": i === current ? "step" : false,
          "aria-label": `Question ${q.number}, ${states.join(", ")}`,
          "data-key": `cell-${i}`,
          onclick: () => goTo(i),
          text: String(q.number),
        });
      }),
    );

    const bookmarkedCount = quiz.questions.filter((q) => q.response.bookmarked).length;
    return h(
      "aside",
      { class: "palette", "aria-label": "All questions" },
      h("h2", { text: "Questions" }),
      grid,
      h(
        "ul",
        { class: "legend" },
        h("li", {}, h("span", { class: "swatch answered" }), "Answered"),
        h("li", {}, h("span", { class: "swatch" }), "Not answered"),
        h("li", {}, h("span", { class: "swatch bookmarked" }), `Bookmarked (${bookmarkedCount})`),
      ),
      readOnly()
        ? null
        : h("button", { type: "button", class: "primary submit", "data-key": "submit", onclick: openReview, text: "Submit answers" }),
    );


  }

  function render({ resetFocus = false } = {}) {
    const focusKey = document.activeElement?.dataset?.key;
    const scroll = window.scrollY;
    app.replaceChildren(
      renderHeader(),
      renderBanner() ?? "",
      h("main", { class: "layout" }, renderQuestion(), renderPalette()),
      renderDialog(),
    );
    setSaveState(readOnly() ? "locked" : saveState);
    tick();
    if (resetFocus) {
      document.getElementById("q-title")?.focus({ preventScroll: true });
      if (window.matchMedia("(max-width: 800px)").matches) app.querySelector(".question-panel")?.scrollIntoView({ block: "start" });
    } else {
      window.scrollTo(0, scroll);
      if (focusKey) app.querySelector(`[data-key="${focusKey}"]`)?.focus({ preventScroll: true });
    }
  }

  // ---------- Review & submit ----------

  function renderDialog() {
    return h("dialog", { id: "review", "aria-labelledby": "review-title" });
  }

  function numberList(title, questions, emptyText) {
    return h(
      "div",
      { class: "review-group" },
      h("h3", { text: `${title} (${questions.length})` }),
      questions.length
        ? h(
            "div",
            { class: "review-links" },
            questions.map((q) =>
              h("button", {
                type: "button",
                class: "cell",
                onclick: () => {
                  document.getElementById("review").close();
                  goTo(q.number - 1);
                },
                text: String(q.number),
              }),
            ),
          )
        : h("p", { class: "muted", text: emptyText }),
    );
  }

  function openReview() {
    flushComment();
    const dialog = document.getElementById("review");
    const unanswered = quiz.questions.filter((q) => !q.response.selected);
    const bookmarked = quiz.questions.filter((q) => q.response.bookmarked);
    const error = h("p", { class: "error", role: "alert" });
    const submit = h("button", {
      type: "button",
      class: "primary",
      text: "Submit answers",
      onclick: async () => {
        submit.disabled = true;
        submit.textContent = "Submitting…";
        error.textContent = "";
        if (!(await drain())) {
          if (readOnly()) return dialog.close();
          error.textContent = "Some answers could not be saved. Check your connection and try again.";
          submit.disabled = false;
          submit.textContent = "Submit answers";
          return;
        }
        try {
          const res = await fetch(`/q/${quiz.id}/submit`, { method: "POST" });
          const body = await res.json().catch(() => ({}));
          if (res.ok || res.status === 409) {
            if (body.submitted_at) quiz.submitted_at = body.submitted_at;
            dialog.close();
            lock(body.status ?? "submitted");
            window.scrollTo(0, 0);
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          console.error(err);
          error.textContent = "Submission failed. Check your connection and try again.";
          submit.disabled = false;
          submit.textContent = "Submit answers";
        }
      },
    });

    dialog.replaceChildren(
      h("h2", { id: "review-title", text: "Submit your answers?" }),
      h("p", { text: `You answered ${total - unanswered.length} of ${total} questions. You won't be able to change your answers after submitting.` }),
      numberList("Not answered", unanswered, "Every question has an answer."),
      numberList("Bookmarked", bookmarked, "No bookmarked questions."),
      error,
      h(
        "div",
        { class: "dialog-actions" },
        h("button", { type: "button", onclick: () => dialog.close(), text: "Back to quiz" }),
        submit,
      ),
    );
    dialog.showModal();
  }

  // ---------- Timer ----------

  function tick() {
    const el = document.getElementById("timer");
    if (!el || !quiz.started_at) return;
    const endAt = quiz.submitted_at ?? quiz.closed_at;
    const end = endAt ? Date.parse(endAt) : now();
    const elapsed = (end - Date.parse(quiz.started_at)) / 1000;
    const limit = quiz.time_limit_seconds;
    el.classList.remove("warning", "over");
    if (limit === null) {
      el.textContent = `${formatDuration(elapsed)} elapsed`;
      return;
    }
    const remaining = limit - elapsed;
    if (remaining >= 0) {
      el.textContent = `${formatDuration(Math.ceil(remaining))} left`;
      if (remaining <= Math.min(300, limit * 0.1)) el.classList.add("warning");
    } else {
      el.textContent = `+${formatDuration(-remaining)} over time`;
      el.classList.add("over");
    }
  }

  // ---------- Global events ----------

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.getElementById("review")?.open) return;
    const target = e.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      goTo(current + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      goTo(current - 1);
    } else if (/^[a-z]$/i.test(e.key) && !readOnly()) {
      const letter = e.key.toUpperCase();
      if (!question().choices.some((c) => c.letter === letter)) return;
      e.preventDefault();
      if (e.shiftKey) toggleStrike(letter);
      else select(letter);
    }
  });

  window.addEventListener("hashchange", () => {
    const index = indexFromHash();
    if (index !== null) goTo(index);
  });

  window.addEventListener("beforeunload", (e) => {
    if (commentTimer || pending.size || inFlight) {
      flushComment();
      e.preventDefault();
    }
  });

  history.replaceState(null, "", `#${current + 1}`);
  render();
  setInterval(tick, 1000);
})();
