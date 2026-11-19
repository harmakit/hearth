export function createInspectorHistory() {
  const stack = [];
  return {
    get current() { return stack.at(-1); },
    get depth() { return stack.length; },
    visit(studioId, kind, id) {
      if (this.current?.studioId !== studioId) stack.length = 0;
      if (this.current?.kind !== kind || this.current.id !== id) stack.push({ studioId, kind, id, scroll:0 });
      return this.current;
    },
    savePosition(scroll) { if (this.current) this.current.scroll = scroll; },
    back() { stack.pop(); return this.current; },
    close() { stack.length = 0; },
  };
}

export function membersOfEpic(epic, stories, tasks) {
  const storyIds = new Set(stories.filter(s=>s.studioId === epic.studioId && s.epicId === epic.id).map(s=>s.id));
  return tasks.filter(t=>t.studioId === epic.studioId && (t.epicId === epic.id || storyIds.has(t.storyId)));
}
