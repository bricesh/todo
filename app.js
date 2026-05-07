/* =========================================================================
   Tasks — standalone web app, with Firebase Authentication
   -------------------------------------------------------------------------
   Gates access behind a Firebase Auth sign-in. With matching DB rules
   (".read"/".write": "auth != null"), only the authenticated user can
   see or modify data. The single-field "access key" lock screen actually
   signs in via email + password under the hood, with the email being a
   fixed value you set up once in the Firebase Console.
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

// The hardcoded "username" half of the credential. Match this to the email
// you created in Firebase Console → Authentication → Users. It does not
// have to be a real, deliverable email — Firebase doesn't verify it.
const ACCESS_EMAIL = "me@tasks.local";

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();
const tasksRef = db.ref('tasks');

// SESSION persistence: signed-in state survives page refreshes within the
// same tab, but clears when the tab/window closes. Closing and reopening
// = re-enter access key. Change to LOCAL if you want persistent sign-in
// across browser restarts.
auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(err => {
	console.warn('Persistence setup failed (non-fatal):', err);
});

let currentTasks = {};
let isEditing = false;
let liveQuery = null;   // active DB query so we can detach on sign-out

/* =========================================================================
   Auth state — drives which screen is visible
   ========================================================================= */

auth.onAuthStateChanged(user => {
	if (user) {
		showApp();
		startListening();
	} else {
		stopListening();
		commitPendingUndo();
		showLockScreen();
	}
});

function showLockScreen() {
	document.getElementById('app').hidden = true;
	const lock = document.getElementById('lockScreen');
	lock.hidden = false;
	document.getElementById('lockDate').textContent = todayLabel();
	const input = document.getElementById('lockInput');
	input.value = '';
	input.focus();
}

function showApp() {
	document.getElementById('lockScreen').hidden = true;
	document.getElementById('app').hidden = false;
}

/* =========================================================================
   Sign in / out
   ========================================================================= */

document.getElementById('lockForm').addEventListener('submit', async (e) => {
	e.preventDefault();
	const input  = document.getElementById('lockInput');
	const errEl  = document.getElementById('lockError');
	const btn    = document.getElementById('lockBtn');
	const label  = btn.querySelector('.lock-btn-label');

	const password = input.value.trim();
	if (!password) return;

	errEl.hidden = true;
	input.classList.remove('is-error');
	btn.disabled = true;
	label.textContent = 'Unlocking…';

	try {
		await auth.signInWithEmailAndPassword(ACCESS_EMAIL, password);
		// Auth state listener takes over from here.
	} catch (err) {
		console.error('Sign-in failed:', err);
		input.classList.add('is-error');
		errEl.hidden = false;
		errEl.textContent = humanizeAuthError(err);
		input.focus();
		input.select();
	} finally {
		btn.disabled = false;
		label.textContent = 'Unlock';
	}
});

document.getElementById('signOutBtn').addEventListener('click', () => {
	auth.signOut().catch(err => console.error('Sign out failed:', err));
});

function humanizeAuthError(err) {
	const code = err && err.code ? err.code : '';
	switch (code) {
		case 'auth/invalid-credential':
		case 'auth/wrong-password':
		case 'auth/user-not-found':
			return 'Incorrect access key.';
		case 'auth/too-many-requests':
			return 'Too many attempts. Try again in a minute.';
		case 'auth/network-request-failed':
			return 'Network error. Check your connection.';
		case 'auth/user-disabled':
			return 'Account disabled.';
		default:
			return err && err.message ? err.message : 'Sign-in failed.';
	}
}

/* =========================================================================
   Live data
   ========================================================================= */

function startListening() {
	if (liveQuery) return;
	liveQuery = tasksRef.orderByChild('done').equalTo(false);
	liveQuery.on('value', snap => {
		currentTasks = snap.val() || {};
		if (!isEditing) render();
	}, err => {
		console.error('DB listener error:', err);
		// If the rules reject us, force sign-out so the user can re-authenticate.
		if (err && (err.code === 'PERMISSION_DENIED' || /permission/i.test(err.message))) {
			auth.signOut();
		}
	});
}

function stopListening() {
	if (liveQuery) {
		liveQuery.off('value');
		liveQuery = null;
	}
	currentTasks = {};
}

/* =========================================================================
   Helpers
   ========================================================================= */

function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, c => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
	}[c]));
}

function todayLabel() {
	return new Date().toLocaleDateString('en-US', {
		weekday: 'long', month: 'long', day: 'numeric'
	}).toUpperCase();
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

function markDone(id) {
	const task = currentTasks[id];
	if (!task) return;

	// If a previous toast is still up, its undo window closes now —
	// only one task is ever undoable at a time (matches Gmail / iOS).
	commitPendingUndo();

	updateField(id, { done: true });

	pendingUndo = { id };
	showUndoToast(task.subject || '(untitled)');
}

/* =========================================================================
   Undo
   -------------------------------------------------------------------------
   Marking a task done writes done:true immediately and shows a toast
   for UNDO_WINDOW_MS. If the user clicks Undo within that window we
   write done:false back. Otherwise the change becomes permanent.
   ========================================================================= */

const UNDO_WINDOW_MS = 10000;

let pendingUndo = null;       // { id } of the task currently undoable, if any
let toastTimerId = null;      // commit timer
let toastHideTimerId = null;  // post-hide cleanup timer

function undoLastDone() {
	if (!pendingUndo) return;
	const id = pendingUndo.id;
	pendingUndo = null;
	hideUndoToast();
	updateField(id, { done: false });
}

function commitPendingUndo() {
	// Closes the undo window without changing data — the done:true write
	// already happened. Used when a new task is marked done, the user
	// signs out, or the timer expires.
	if (pendingUndo) {
		pendingUndo = null;
		hideUndoToast();
	}
}

function showUndoToast(subjectText) {
	const toast    = document.getElementById('toast');
	const subject  = document.getElementById('toastSubject');
	const progress = document.getElementById('toastProgress');

	subject.textContent = subjectText;

	clearTimeout(toastHideTimerId);

	// Reset the progress bar without animating, then animate down to 0%.
	progress.style.transition = 'none';
	progress.style.width = '100%';

	toast.hidden = false;
	void toast.offsetWidth;        // force reflow so .is-visible animates
	toast.classList.add('is-visible');

	requestAnimationFrame(() => {
		progress.style.transition = `width ${UNDO_WINDOW_MS}ms linear`;
		progress.style.width = '0%';
	});

	clearTimeout(toastTimerId);
	toastTimerId = setTimeout(commitPendingUndo, UNDO_WINDOW_MS);
}

function hideUndoToast() {
	clearTimeout(toastTimerId);
	const toast = document.getElementById('toast');
	toast.classList.remove('is-visible');

	// Wait for slide-out before hiding so it doesn't snap.
	clearTimeout(toastHideTimerId);
	toastHideTimerId = setTimeout(() => { toast.hidden = true; }, 280);
}

document.getElementById('toastUndo').addEventListener('click', undoLastDone);

/* =========================================================================
   Edit mode
   -------------------------------------------------------------------------
   Two flavors. Wide viewports get inline editing — turn the row's cells
   into inputs in place. Narrow viewports (phones) get a bottom-sheet modal,
   because inline editing on a 360px-wide screen is a bad time. The
   breakpoint is the same one the CSS uses to switch to the stacked card
   layout, so the trigger is consistent with the visual context.
   ========================================================================= */

const MOBILE_BREAKPOINT = '(max-width: 600px)';

function setEditMode(id) {
	if (window.matchMedia(MOBILE_BREAKPOINT).matches) {
		openEditSheet(id);
	} else {
		setInlineEditMode(id);
	}
}

/* ---------- Sheet (mobile) ---------- */

let sheetTaskId = null;
let sheetCloseTimerId = null;
let sheetReturnFocusEl = null;

function openEditSheet(id) {
	const task = currentTasks[id];
	if (!task) return;

	sheetTaskId = id;
	sheetReturnFocusEl = document.activeElement;

	document.getElementById('sheetSubject').value = task.subject  || '';
	document.getElementById('sheetProject').value = task.project  || '';
	document.getElementById('sheetDate').value    = task.due_date || '';

	const backdrop = document.getElementById('sheetBackdrop');
	const sheet    = document.getElementById('sheet');

	clearTimeout(sheetCloseTimerId);
	backdrop.hidden = false;
	sheet.hidden = false;

	// Force reflow so the slide-up animation actually runs from translateY(100%).
	void sheet.offsetWidth;
	backdrop.classList.add('is-visible');
	sheet.classList.add('is-visible');

	// Focus the subject after the slide-up settles. Selecting all the text
	// makes "edit and replace" workflows fast.
	setTimeout(() => {
		const input = document.getElementById('sheetSubject');
		input.focus();
		input.select();
	}, 340);
}

function closeEditSheet({ save = true } = {}) {
	if (!sheetTaskId) return;

	if (save) commitEditSheet();

	sheetTaskId = null;

	const backdrop = document.getElementById('sheetBackdrop');
	const sheet    = document.getElementById('sheet');

	backdrop.classList.remove('is-visible');
	sheet.classList.remove('is-visible');

	clearTimeout(sheetCloseTimerId);
	sheetCloseTimerId = setTimeout(() => {
		backdrop.hidden = true;
		sheet.hidden = true;
	}, 320);

	// Return focus to whatever opened the sheet, if it still exists.
	if (sheetReturnFocusEl && document.body.contains(sheetReturnFocusEl)) {
		try { sheetReturnFocusEl.focus(); } catch (_) {}
	}
	sheetReturnFocusEl = null;
}

function commitEditSheet() {
	if (!sheetTaskId) return;
	const id = sheetTaskId;
	const task = currentTasks[id] || {};

	const newSubject = document.getElementById('sheetSubject').value.trim();
	const newProject = document.getElementById('sheetProject').value.trim();
	const newDate    = document.getElementById('sheetDate').value;

	// Diff against the existing values so we don't write no-op updates
	// (which would still trigger the live listener and re-render).
	const updates = {};
	if (newSubject !== (task.subject  || '')) updates.subject  = newSubject;
	if (newProject !== (task.project  || '')) updates.project  = newProject;
	if (newDate    !== (task.due_date || '')) updates.due_date = newDate;

	if (Object.keys(updates).length > 0) {
		updateField(id, updates);
	}
}

// Wire up sheet interactions. All paths save then close.
document.getElementById('sheetForm').addEventListener('submit', (e) => {
	e.preventDefault();
	closeEditSheet({ save: true });
});
document.getElementById('sheetBackdrop').addEventListener('click', () => {
	closeEditSheet({ save: true });
});
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape' && sheetTaskId) {
		closeEditSheet({ save: true });
	}
});

/* ---------- Inline (desktop) ---------- */

function setInlineEditMode(id) {
	const row = document.getElementById(id);
	if (!row || row.classList.contains('is-editing')) return;
	row.classList.add('is-editing');
	isEditing = true;

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

	subjectInput.addEventListener("change", () => updateField(id, { subject: subjectInput.value }));
	projectInput.addEventListener("change", () => updateField(id, { project: projectInput.value }));
	dueInput.addEventListener("change",     () => updateField(id, { due_date: dueInput.value }));

	row.addEventListener("focusout", () => {
		setTimeout(() => {
			if (!row.contains(document.activeElement)) {
				isEditing = false;
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

/* =========================================================================
   Landscape views (week + kanban pager)
   -------------------------------------------------------------------------
   When the phone is in landscape, body gets .show-landscape-views and
   the .task-list is replaced by a horizontal pager containing two pages:
   week view (calendar) and kanban view (project columns). The user
   swipes left/right between them; scroll-snap handles the snapping.

   Both views render from currentTasks. Tapping a task on either page
   opens the same edit sheet used in portrait mode.
   ========================================================================= */

const LANDSCAPE_QUERY =
	'(orientation: landscape) and (max-width: 950px) and (max-height: 500px)';

function isLandscapeViewsActive() {
	return window.matchMedia(LANDSCAPE_QUERY).matches;
}

function applyOrientationClass() {
	document.body.classList.toggle('show-landscape-views', isLandscapeViewsActive());
}

applyOrientationClass();
window.matchMedia(LANDSCAPE_QUERY).addEventListener('change', () => {
	applyOrientationClass();
	render();
	// Reset to week view (page 0) on orientation flip.
	const pager = document.getElementById('landscapePager');
	if (pager) pager.scrollLeft = 0;
});

// Track which page is active so the dot indicator stays in sync.
// Updated via scroll listener (debounced via rAF) on the pager.
{
	const pager = document.getElementById('landscapePager');
	if (pager) {
		let raf = null;
		pager.addEventListener('scroll', () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = null;
				const pageWidth = pager.clientWidth;
				if (!pageWidth) return;
				const activePage = Math.round(pager.scrollLeft / pageWidth);
				document.querySelectorAll('.landscape-dot').forEach((dot, i) => {
					dot.classList.toggle('is-active', i === activePage);
				});
			});
		}, { passive: true });
	}
}

function isoDate(d) {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

/* ---------- Shared task chip used in both week + kanban ---------- */

function taskChipHtml(id, task, todayIso) {
	const due = task.due_date;
	let stateClass = '';
	let metaText = '';

	if (due) {
		if (due < todayIso) stateClass = 'is-overdue';
		else if (due === todayIso) stateClass = 'is-today';

		// Compact meta: "May 12" / "Today" / "3d overdue"
		metaText = formatDue(due).label;
	}

	return `<button class="lv-task ${stateClass}" type="button" data-id="${escapeHtml(id)}" title="${escapeHtml(task.subject || '')}">
		<span class="lv-task-subject">${escapeHtml(task.subject || '')}</span>
		${metaText ? `<span class="lv-task-meta">${escapeHtml(metaText)}</span>` : ''}
	</button>`;
}

function wireTaskChips(rootEl) {
	rootEl.querySelectorAll('.lv-task').forEach(btn => {
		btn.addEventListener('click', () => openEditSheet(btn.dataset.id));
	});
}

/* ---------- Week view ---------- */

function renderWeekView(ids) {
	const grid = document.getElementById('weekGrid');
	grid.innerHTML = '';

	const dated = ids.filter(id => currentTasks[id].due_date);

	let startDate;
	if (dated.length === 0) {
		startDate = new Date();
	} else {
		const earliest = dated.map(id => currentTasks[id].due_date).sort()[0];
		startDate = new Date(earliest + 'T00:00:00');
	}
	startDate.setHours(0, 0, 0, 0);

	const todayIso = isoDate(new Date());

	const byDate = {};
	dated.forEach(id => {
		const d = currentTasks[id].due_date;
		(byDate[d] = byDate[d] || []).push(id);
	});

	for (let i = 0; i < 7; i++) {
		const dayDate = new Date(startDate);
		dayDate.setDate(startDate.getDate() + i);
		const dayIso = isoDate(dayDate);

		const col = document.createElement('div');
		col.className = 'week-day' + (dayIso === todayIso ? ' is-today' : '');

		const dow = dayDate.toLocaleDateString('en-US', { weekday: 'short' });
		const num = dayDate.getDate();

		const dayTaskIds = (byDate[dayIso] || []);
		const tasksHtml = dayTaskIds
			.map(id => taskChipHtml(id, currentTasks[id], todayIso))
			.join('');

		col.innerHTML = `
			<div class="week-day-header">
				<span class="week-day-dow">${escapeHtml(dow)}</span>
				<span class="week-day-num">${num}</span>
			</div>
			<div class="week-day-tasks">
				${tasksHtml || '<div class="week-day-empty">—</div>'}
			</div>
		`;

		grid.appendChild(col);
	}

	wireTaskChips(grid);
}

/* ---------- Kanban view ---------- */

function renderKanbanView(ids) {
	const board = document.getElementById('kanbanBoard');
	board.innerHTML = '';

	const todayIso = isoDate(new Date());

	// Bucket by project. The empty-string key collects "no project" tasks.
	const byProject = {};
	ids.forEach(id => {
		const project = (currentTasks[id].project || '').trim();
		(byProject[project] = byProject[project] || []).push(id);
	});

	// Project columns: real projects sorted alphabetically, then "no project"
	// at the end. Skipping "no project" if there are none.
	const projectNames = Object.keys(byProject)
		.filter(p => p !== '')
		.sort((a, b) => a.localeCompare(b));

	if (byProject['']) projectNames.push('');

	// Sort each column: overdue/earliest due date first; undated tasks last.
	const sortIds = (taskIds) => taskIds.sort((a, b) => {
		const da = currentTasks[a].due_date || '9999-99-99';
		const db = currentTasks[b].due_date || '9999-99-99';
		return da.localeCompare(db);
	});

	projectNames.forEach(project => {
		const colIds = sortIds(byProject[project].slice());
		const col = document.createElement('div');
		col.className = 'kanban-column' + (project === '' ? ' is-empty-project' : '');

		const displayName = project || 'No project';
		const tasksHtml = colIds
			.map(id => taskChipHtml(id, currentTasks[id], todayIso))
			.join('');

		col.innerHTML = `
			<div class="kanban-column-header">
				<span class="kanban-column-name">${escapeHtml(displayName)}</span>
				<span class="kanban-column-count">${colIds.length}</span>
			</div>
			<div class="kanban-column-tasks">${tasksHtml}</div>
		`;

		board.appendChild(col);
	});

	wireTaskChips(board);
}

/* =========================================================================
   Render
   ========================================================================= */

function render() {
	const taskBody     = document.getElementById('taskBody');
	const emptyState   = document.getElementById('emptyState');
	const taskCount    = document.getElementById('taskCount');
	const todayDate    = document.getElementById('todayDate');
	const listProjects = document.getElementById('listProjects');

	todayDate.textContent = todayLabel();

	const ids = Object.keys(currentTasks).filter(id =>
		currentTasks[id] && currentTasks[id].done === false
	);
	taskCount.textContent = ids.length;

	// Datalist always populated — used by both inline editor and edit sheet.
	const projects = [...new Set(ids.map(id => currentTasks[id].project).filter(Boolean))];
	listProjects.innerHTML = projects
		.map(p => `<option value="${escapeHtml(p)}">`)
		.join('');

	// Landscape views (week + kanban pager) render alongside the list.
	// CSS hides whichever isn't appropriate for the current orientation.
	if (isLandscapeViewsActive()) {
		renderWeekView(ids);
		renderKanbanView(ids);
	}

	if (ids.length === 0) {
		taskBody.style.display = 'none';
		emptyState.hidden = false;
		return;
	}
	taskBody.style.display = '';
	emptyState.hidden = true;

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
			<button class="task-check" type="button" id="done${id}" aria-label="Mark done"></button>
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
