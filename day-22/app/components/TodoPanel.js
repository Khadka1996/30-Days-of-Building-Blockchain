"use client";
import { useState } from "react";
import { useConnection, useReadContract } from "wagmi";
import { todoList } from "../lib/wagmi";
import { MAX_TASK_BYTES, validateTaskText } from "../lib/guards";
import { useSafeWrite } from "../lib/useSafeWrite";
import TxStatus from "./TxStatus";

export default function TodoPanel({ canWrite }) {
  const { address } = useConnection();
  const [text, setText] = useState("");
  const [formError, setFormError] = useState("");
  const { send, tx, busy } = useSafeWrite();
  const tasks = useReadContract({ ...todoList, functionName: "getTasks", args: [address], query: { enabled: !!address } });
  const locked = !canWrite || busy;

  async function onAdd(e) {
    e.preventDefault();
    const v = validateTaskText(text);
    setFormError(v.message);
    if (!v.ok) return;
    // Clear the box only after a confirmed add (keep it on reject / error).
    await send({ contract: todoList, functionName: "addTask", args: [v.value], label: "Add task", onSuccess: () => setText("") });
  }

  const list = tasks.data ?? [];
  return (
    <section className="card" aria-labelledby="todo-h">
      <h2 id="todo-h">📝 To-do list <span className="muted small">Day 1</span></h2>
      <form onSubmit={onAdd} className="row">
        <input aria-label="New task" placeholder="What needs doing?" value={text} maxLength={MAX_TASK_BYTES}
          onChange={(e) => setText(e.target.value)} disabled={locked} />
        <button type="submit" disabled={locked} data-testid="add-task">Add</button>
      </form>
      {formError && <p className="error">{formError}</p>}
      <TxStatus tx={tx} />
      {tasks.isLoading ? <p className="muted">Loading…</p> : list.length === 0 ? (
        <p className="muted" data-testid="empty">No tasks yet.</p>
      ) : (
        <ul className="tasks" data-testid="tasks">
          {list.map((t) => (
            <li key={String(t.id)} className={t.completed ? "done" : ""}>
              {/* React escapes this text: a task can never inject HTML or scripts. */}
              <span className="task-text">{t.text}</span>
              <span className="actions">
                {!t.completed && (
                  <button className="ghost" disabled={locked} aria-label={`Complete task ${t.id}`}
                    onClick={() => send({ contract: todoList, functionName: "completeTask", args: [t.id], label: "Complete" })}>✓</button>
                )}
                <button className="ghost" disabled={locked} aria-label={`Delete task ${t.id}`}
                  onClick={() => send({ contract: todoList, functionName: "deleteTask", args: [t.id], label: "Delete" })}>✕</button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
