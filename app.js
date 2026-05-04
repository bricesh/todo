/* =========================================================================
   Tasks — standalone web app
   Talks to Firebase Realtime Database directly. A live listener keeps the
   view in sync across devices without manual refresh.
   ========================================================================= */

const firebaseConfig = {
	apiKey: "AIzaSyCikaDvIt_lLrE_aKgp0qtYobDYtAJwMOU",
	authDomain: "mytodolist-8b55d.firebaseapp.com",
	databaseURL: "https://mytodolist-8b55d-default-rtdb.europe-west1.firebasedatabase.app",
	projectId: "mytodolist-8b55d",
	storageBucket: "mytodolist-8b55d.appspot.com",
	messagingSenderId: "413102550206",
	appId: "1:413102550206:web:45b8d25b98ff39e58982ef"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const tasksRef = db.ref('tasks');

let currentTasks = {};
let isEditing = false;       // suppresses re-renders while a row is being edited
let editingRowId = null;

/* ---------- Live data ---------- */

// Realtime listener — fires once on load and again every time the data
// changes (from this tab, another tab, the Make scenario, or any other
// device). The `isEditing` flag stops a save-triggered re-render from
// kicking the user out of an open edit row.
tasksRef.orderByChild('done').equalTo(false).on('value', snap => {
	currentTasks = snap.val() || {};
	if (!isEditing) render();
}, err => {
	console.error('Firebase listener error:', err);
});

/* ---------- Helpers ---------- */

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, c => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[c]));
}

function formatDue(isoDate) {
	if (!isoDate) return { label: '—', cls: '', state: '' };

	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const due = new Date(isoDate + 'T00:00:00');
	due.setHours(0, 0, 0, 0);

	const diffDays = Math.round((due - today) / 86400000);

	let label;
	if (diffDays === 0)       label = 'Today';
	else if (diffDays === 1)  label = 'Tomorrow';
	else if (diffDays === -1) label = 'Yesterday';
	else if (diffDays < 0)    label = `${Math.abs(diffDays)}d overdue`;
	else if (diffDays < 7)    label = due.toLocaleDateString('en-US', { weekday: 'long' });
	else                      label = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

	let cls = '', state = '';
	if (diffDays < 0)        { cls = 'overdue'; state = 'is-overdue'; }
	else if (diffDays === 0) { cls = 'today';   state = 'is-today';   }

	return { label, cls, state };
}

function updateField(id, fields) {
	return tasksRef.child(id).update(fields).catch(err => {
		console.error('update failed:', err);
	});
}

/* ---------- Actions ---------- */

function markDone(id) {
	updateField(id, { done: true });
	// Live listener picks it up and re-renders automatically.
}

/* ---------- Edit mode ---------- */

function setEditMode(id) {
	const row = document.getElementById(id);
	if (!row || row.classList.contains('is-editing')) return;
	row.classList.add('is-editing');
	isEditing = true;
	editingRowId = id;

	const subjectEl = row.querySelector('.task-subject');
	const projectEl = row.querySelector('.task-project');
	const dueEl     = row.querySelector('.task-due');

	const subjectVal = subjectEl ? subjectEl.textContent.trim() : '';
	const projectVal = projectEl ? projectEl.textContent.trim() : '';
	const dueVal     = (dueEl && dueEl.dataset.iso) ? dueEl.dataset.iso : '';

	subjectEl.outerHTML =
		`<input class="task-input" type="text" id="subject${id}" value="${escapeHtml(subjectVal)}">`;
	projectEl.outerHTML =
		`<input class="task-input task-input--mono task-input--project" list="listProjects" id="project${id}" value="${escapeHtml(projectVal)}" placeholder="Project">`;
	dueEl.outerHTML =
		`<input class="task-input task-input--mono task-input--date" type="date" id="due${id}" value="${escapeHtml(dueVal)}">`;

	const subjectInput = document.getElementById("subject" + id);
	const projectInput = document.getElementById("project" + id);
	const dueInput     = document.getElementById("due" + id);

	// Save individual fields when their value changes — silently, no re-render.
	subjectInput.addEventListener("change", () => updateField(id, { subject: subjectInput.value }));
	projectInput.addEventListener("change", () => updateField(id, { project: projectInput.value }));
	dueInput.addEventListener("change",     () => updateField(id, { due_date: dueInput.value }));

	// Re-render only when focus actually leaves the row.
	row.addEventListener("focusout", () => {
		setTimeout(() => {
			if (!row.contains(document.activeElement)) {
				isEditing = false;
				editingRowId = null;
				render();
			}
		}, 120);
	});

	const commitOnEnter = (e) => {
		if (e.key === "Enter" || e.key === "Escape") e.target.blur();
	};
	subjectInput.addEventListener("keydown", commitOnEnter);
	projectInput.addEventListener("keydown", commitOnEnter);
	dueInput.addEventListener("keydown", commitOnEnter);

	subjectInput.focus();
	subjectInput.select();
}

/* ---------- Render ---------- */

function render() {
	const taskBody     = document.getElementById('taskBody');
	const emptyState   = document.getElementById('emptyState');
	const taskCount    = document.getElementById('taskCount');
	const todayDate    = document.getElementById('todayDate');
	const listProjects = document.getElementById('listProjects');

	todayDate.textContent = new Date().toLocaleDateString('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	}).toUpperCase();

	const ids = Object.keys(currentTasks).filter(id =>
		currentTasks[id] && currentTasks[id].done === false
	);
	taskCount.textContent = ids.length;

	if (ids.length === 0) {
		taskBody.style.display = 'none';
		emptyState.hidden = false;
		listProjects.innerHTML = '';
		return;
	}
	taskBody.style.display = '';
	emptyState.hidden = true;

	// Datalist of unique projects (for autocomplete in edit mode)
	const projects = [...new Set(ids.map(id => currentTasks[id].project).filter(Boolean))];
	listProjects.innerHTML = projects
		.map(p => `<option value="${escapeHtml(p)}">`)
		.join('');

	// Sort: overdue / earliest first, undated last
	ids.sort((a, b) => {
		const da = currentTasks[a].due_date || '9999-99-99';
		const db = currentTasks[b].due_date || '9999-99-99';
		return da.localeCompare(db);
	});

	taskBody.innerHTML = '';

	ids.forEach((id, i) => {
		const task = currentTasks[id];
		const due = formatDue(task.due_date);

		const row = document.createElement('div');
		row.className = `task ${due.state}`.trim();
		row.id = id;
		row.style.animationDelay = `${Math.min(i * 25, 250)}ms`;

		row.innerHTML = `
			<button class="task-check" id="done${id}" aria-label="Mark done"></button>
			<div class="task-content">
				<div class="task-subject">${escapeHtml(task.subject || '')}</div>
			</div>
			<span class="task-project">${escapeHtml(task.project || '')}</span>
			<span class="task-due ${due.cls}" data-iso="${escapeHtml(task.due_date || '')}">${escapeHtml(due.label)}</span>
			<button class="task-edit" id="edit${id}" aria-label="Edit task">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
					<path d="M12 20h9"/>
					<path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
				</svg>
			</button>
		`;

		taskBody.appendChild(row);

		document.getElementById("done" + id).addEventListener("click", () => markDone(id));
		document.getElementById("edit" + id).addEventListener("click", () => setEditMode(id));
	});
}
