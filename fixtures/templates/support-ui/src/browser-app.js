import {
  bindAssignmentControl,
  bindNoteControl,
  bindStatusControl,
  createSupportBoardClient,
  readFilterValues,
  renderSupportBoard,
} from "./index.js";

const agents = [
  { id: "agent-ava", displayName: "Ava" },
  { id: "agent-ben", displayName: "Ben" },
  { id: "agent-cy", displayName: "Cy" },
];

const app = document.querySelector("#app");
const client = createSupportBoardClient();
const state = {
  filters: {},
  selectedTicketId: "",
  errors: {},
};

refreshBoard().catch((error) => renderFatalError(error));

async function refreshBoard(nextState = {}) {
  Object.assign(state, nextState);
  const board = await client.loadBoard({
    filters: state.filters,
    selectedTicketId: state.selectedTicketId,
  });
  state.selectedTicketId = board.selectedTicket?.id ?? board.tickets?.[0]?.id ?? "";
  renderBoard(board);
}

function renderBoard(board) {
  app.innerHTML = renderSupportBoard({
    summary: board.summary,
    filters: state.filters,
    agents,
    tickets: board.tickets,
    selectedTicketId: state.selectedTicketId,
    selectedTicket: board.selectedTicket,
    errors: state.errors,
  });
  bindBoardInteractions();
}

function bindBoardInteractions() {
  const filterForm = document.querySelector("[data-live-filter-toolbar]");
  filterForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    state.filters = readFilterValues(filterForm);
    state.selectedTicketId = "";
    state.errors = {};
    refreshBoard().catch((error) => renderFatalError(error));
  });
  filterForm?.addEventListener("change", () => {
    state.filters = readFilterValues(filterForm);
    state.selectedTicketId = "";
    state.errors = {};
    refreshBoard().catch((error) => renderFatalError(error));
  });
  filterForm?.addEventListener("reset", () => {
    window.setTimeout(() => {
      state.filters = {};
      state.selectedTicketId = "";
      state.errors = {};
      refreshBoard().catch((error) => renderFatalError(error));
    }, 0);
  });

  for (const row of document.querySelectorAll("[data-ticket-id]")) {
    row.addEventListener("click", () => {
      state.selectedTicketId = row.dataset.ticketId ?? "";
      state.errors = {};
      refreshBoard().catch((error) => renderFatalError(error));
    });
  }

  const refreshFromAction = (boardState) => {
    state.selectedTicketId = boardState.selectedTicket?.id ?? state.selectedTicketId;
    state.errors = {};
    renderBoard(boardState);
  };
  const recordActionError = (message, options = {}) => {
    state.selectedTicketId = options.selectedTicketId ?? state.selectedTicketId;
    state.errors = { detail: message, assignment: message, status: message, note: message };
    refreshBoard().catch((error) => renderFatalError(error));
  };

  const assignmentForm = document.querySelector("[data-live-assignment-control]");
  if (assignmentForm) {
    bindAssignmentControl({
      form: assignmentForm,
      client,
      filters: state.filters,
      onRefresh: refreshFromAction,
      onError: recordActionError,
    });
  }

  const statusForm = document.querySelector("[data-live-status-control]");
  if (statusForm) {
    bindStatusControl({
      form: statusForm,
      client,
      filters: state.filters,
      onRefresh: refreshFromAction,
      onError: recordActionError,
    });
  }

  const noteForm = document.querySelector("[data-live-note-control]");
  if (noteForm) {
    bindNoteControl({
      form: noteForm,
      client,
      filters: state.filters,
      author: "Ava",
      onRefresh: refreshFromAction,
      onError: recordActionError,
    });
  }
}

function renderFatalError(error) {
  const message = error instanceof Error ? error.message : String(error);
  app.innerHTML = `<main class="support-board"><h1 class="support-board__title">Customer Support Triage Board</h1><p role="alert">Unable to load review board: ${escapeHtml(message)}</p></main>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
