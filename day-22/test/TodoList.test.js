const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const fc = require("fast-check");

describe("TodoList", function () {
  async function deploy() {
    const [alice, bob] = await ethers.getSigners();
    const todo = await ethers.deployContract("TodoList");
    return { todo, alice, bob };
  }

  // Helper: plain-object view of a list for easy comparisons.
  async function listOf(todo, owner) {
    const tasks = await todo.getTasks(owner);
    return tasks.map((t) => ({ id: Number(t.id), completed: t.completed, text: t.text }));
  }

  describe("adding tasks", function () {
    it("adds a task with id 1 and emits TaskAdded", async function () {
      const { todo, alice } = await loadFixture(deploy);
      await expect(todo.addTask("Buy milk")).to.emit(todo, "TaskAdded").withArgs(alice.address, 1, "Buy milk");
      expect(await listOf(todo, alice.address)).to.deep.equal([{ id: 1, completed: false, text: "Buy milk" }]);
      const task = await todo.getTask(alice.address, 1);
      expect(task.createdAt).to.be.greaterThan(0n);
    });

    it("gives every user their own list and their own ids", async function () {
      const { todo, alice, bob } = await loadFixture(deploy);
      await todo.connect(alice).addTask("Alice task");
      await todo.connect(bob).addTask("Bob task");
      expect(await listOf(todo, alice.address)).to.deep.equal([{ id: 1, completed: false, text: "Alice task" }]);
      expect(await listOf(todo, bob.address)).to.deep.equal([{ id: 1, completed: false, text: "Bob task" }]);
    });

    it("rejects empty text", async function () {
      const { todo } = await loadFixture(deploy);
      await expect(todo.addTask("")).to.be.revertedWithCustomError(todo, "EmptyText");
    });

    it("accepts 280 bytes but rejects 281", async function () {
      const { todo } = await loadFixture(deploy);
      await expect(todo.addTask("a".repeat(280))).to.not.be.reverted;
      await expect(todo.addTask("a".repeat(281)))
        .to.be.revertedWithCustomError(todo, "TextTooLong")
        .withArgs(281, 280);
    });

    it("stops at 100 tasks per user", async function () {
      const { todo, bob } = await loadFixture(deploy);
      for (let i = 0; i < 100; i++) await todo.addTask(`task ${i}`);
      await expect(todo.addTask("one too many")).to.be.revertedWithCustomError(todo, "TooManyTasks").withArgs(100);
      // Bob is not affected by Alice's full list.
      await expect(todo.connect(bob).addTask("Bob is fine")).to.not.be.reverted;
    });
  });

  describe("completing tasks", function () {
    it("marks a task done and emits TaskCompleted", async function () {
      const { todo, alice } = await loadFixture(deploy);
      await todo.addTask("Write tests");
      await expect(todo.completeTask(1)).to.emit(todo, "TaskCompleted").withArgs(alice.address, 1);
      expect((await todo.getTask(alice.address, 1)).completed).to.equal(true);
    });

    it("refuses to complete the same task twice", async function () {
      const { todo } = await loadFixture(deploy);
      await todo.addTask("Once");
      await todo.completeTask(1);
      await expect(todo.completeTask(1)).to.be.revertedWithCustomError(todo, "AlreadyCompleted").withArgs(1);
    });

    it("reverts for an unknown id (including id 0)", async function () {
      const { todo } = await loadFixture(deploy);
      await todo.addTask("Only task");
      await expect(todo.completeTask(0)).to.be.revertedWithCustomError(todo, "TaskNotFound").withArgs(0);
      await expect(todo.completeTask(2)).to.be.revertedWithCustomError(todo, "TaskNotFound").withArgs(2);
    });
  });

  describe("deleting tasks", function () {
    it("deletes a task and keeps other ids stable", async function () {
      const { todo, alice } = await loadFixture(deploy);
      await todo.addTask("one");
      await todo.addTask("two");
      await todo.addTask("three");
      await expect(todo.deleteTask(1)).to.emit(todo, "TaskDeleted").withArgs(alice.address, 1);
      // Task 3 was moved into the gap, but its id is unchanged.
      await todo.completeTask(3);
      expect((await todo.getTask(alice.address, 3)).text).to.equal("three");
      expect((await todo.getTask(alice.address, 3)).completed).to.equal(true);
      expect((await todo.getTask(alice.address, 2)).completed).to.equal(false);
      expect(await todo.taskCount(alice.address)).to.equal(2n);
    });

    it("never reuses a deleted id", async function () {
      const { todo, alice } = await loadFixture(deploy);
      await todo.addTask("one");
      await todo.deleteTask(1);
      await expect(todo.addTask("new")).to.emit(todo, "TaskAdded").withArgs(alice.address, 2, "new");
      await expect(todo.getTask(alice.address, 1)).to.be.revertedWithCustomError(todo, "TaskNotFound");
    });

    it("cannot delete the same task twice", async function () {
      const { todo } = await loadFixture(deploy);
      await todo.addTask("one");
      await todo.deleteTask(1);
      await expect(todo.deleteTask(1)).to.be.revertedWithCustomError(todo, "TaskNotFound").withArgs(1);
    });

    it("deleting the last task works", async function () {
      const { todo, alice } = await loadFixture(deploy);
      await todo.addTask("one");
      await todo.addTask("two");
      await todo.deleteTask(2);
      expect(await listOf(todo, alice.address)).to.deep.equal([{ id: 1, completed: false, text: "one" }]);
    });
  });

  describe("security: only the owner can edit a list", function () {
    it("Bob cannot complete or delete Alice's task", async function () {
      const { todo, alice, bob } = await loadFixture(deploy);
      await todo.connect(alice).addTask("Alice's secret plan");
      // Bob has no task 1, so the lookup is in HIS list and fails.
      await expect(todo.connect(bob).completeTask(1)).to.be.revertedWithCustomError(todo, "TaskNotFound");
      await expect(todo.connect(bob).deleteTask(1)).to.be.revertedWithCustomError(todo, "TaskNotFound");
      expect(await listOf(todo, alice.address)).to.deep.equal([{ id: 1, completed: false, text: "Alice's secret plan" }]);
    });

    it("Bob's actions with the same id only touch Bob's own list", async function () {
      const { todo, alice, bob } = await loadFixture(deploy);
      await todo.connect(alice).addTask("Alice");
      await todo.connect(bob).addTask("Bob");
      await todo.connect(bob).completeTask(1);
      await todo.connect(bob).deleteTask(1);
      expect(await listOf(todo, alice.address)).to.deep.equal([{ id: 1, completed: false, text: "Alice" }]);
      expect(await todo.taskCount(bob.address)).to.equal(0n);
    });
  });

  describe("fuzz: random add / complete / delete sequences match a simple model", function () {
    it("contract state always equals the JavaScript model (50 random runs)", async function () {
      this.timeout(120000);
      const { todo, alice, bob } = await loadFixture(deploy);
      const users = [alice, bob];

      const op = fc.oneof(
        fc.record({ kind: fc.constant("add"), user: fc.nat(1), text: fc.string({ minLength: 1, maxLength: 20 }) }),
        fc.record({ kind: fc.constant("complete"), user: fc.nat(1), id: fc.nat(8) }),
        fc.record({ kind: fc.constant("delete"), user: fc.nat(1), id: fc.nat(8) })
      );

      await fc.assert(
        fc.asyncProperty(fc.array(op, { maxLength: 15 }), async (ops) => {
          const fresh = await ethers.deployContract("TodoList");
          // model: per user, a Map id -> {completed, text}, plus nextId
          const model = users.map(() => ({ tasks: new Map(), nextId: 0 }));

          for (const o of ops) {
            const signer = users[o.user];
            const m = model[o.user];
            if (o.kind === "add") {
              await fresh.connect(signer).addTask(o.text);
              m.nextId += 1;
              m.tasks.set(m.nextId, { completed: false, text: o.text });
            } else if (o.kind === "complete") {
              const t = m.tasks.get(o.id);
              if (!t || t.completed) {
                await expect(fresh.connect(signer).completeTask(o.id)).to.be.reverted;
              } else {
                await fresh.connect(signer).completeTask(o.id);
                t.completed = true;
              }
            } else {
              if (!m.tasks.has(o.id)) {
                await expect(fresh.connect(signer).deleteTask(o.id)).to.be.reverted;
              } else {
                await fresh.connect(signer).deleteTask(o.id);
                m.tasks.delete(o.id);
              }
            }
          }

          // Invariant: on-chain lists match the model exactly (as sets keyed by id).
          for (let u = 0; u < users.length; u++) {
            const onChain = (await listOf(fresh, users[u].address)).sort((a, b) => a.id - b.id);
            const expected = [...model[u].tasks.entries()]
              .map(([id, t]) => ({ id, completed: t.completed, text: t.text }))
              .sort((a, b) => a.id - b.id);
            expect(onChain).to.deep.equal(expected);
          }
        }),
        { numRuns: 50 }
      );
    });
  });
});
