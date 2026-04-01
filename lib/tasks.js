class TaskManager {
    constructor() {
        this.queue = [];
        this.results = {};
    }

    // Add task to queue
    add(task) {
        this.queue.push(task);
        return task.id;
    }

    // Get next task
    async get(type) {
        const idx = this.queue.findIndex(t => t.type === type);
        if (idx === -1) return null;

        return this.queue.splice(idx, 1)[0];
    }

    // Approve task (mark as done)
    async approve(id, data = null) {
        this.results[id] = { status: "approved", data };
        console.log(`[TaskManager] Approved task ${id}`, data);
        return true;
    }

    // Mark error
    async error(id, msg) {
        this.results[id] = { status: "error", message: msg };
        console.error(`[TaskManager] Error on task ${id}: ${msg}`);
        return true;
    }

    // Cancel
    async cancel(id, reason = "") {
        this.results[id] = { status: "cancelled", reason };
        console.warn(`[TaskManager] Cancelled task ${id}`, reason);
        return true;
    }
}

module.exports = new TaskManager();