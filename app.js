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
let isSwiping = false;
let liveQuery = null;

// Auto-edit the next-rendered task. Used after createNewTask: we write
// the empty task to Firebase, the listener fires, render() builds the
// row, then setEditMode opens the editor on it.
let pendingEditId = null;

// Tasks created via the + button that haven't yet received a subject.
// On edit-exit, if subject is still empty, the task is auto-deleted to
// avoid littering the list with empty drafts.
const newlyCreatedIds = new Set();   // active DB query so we can detach on sign-out

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
		if (!isEditing && !isSwiping) render();
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

// Sort comparator: by due_date asc, then by due_time asc within the
// same date. Tasks without a date sink to the bottom; within a given
// date, tasks without a time also sink (sentinel "99:99" sorts last
// since "0"-"9" all precede ":").
function compareTasksByDueDateTime(a, b) {
	const ta = currentTasks[a], tb = currentTasks[b];
	const da = ta.due_date || '9999-99-99';
	const db = tb.due_date || '9999-99-99';
	if (da !== db) return da.localeCompare(db);
	const tma = ta.due_time || '99:99';
	const tmb = tb.due_time || '99:99';
	return tma.localeCompare(tmb);
}

function updateField(id, fields) {
	return tasksRef.child(id).update(fields).catch(err => {
		console.error('update failed:', err);
	});
}

/* =========================================================================
   Checklist helpers
   -------------------------------------------------------------------------
   Stored on a task as `task.checklist = [{text, done}, ...]`. Firebase
   RTDB doesn't store JS arrays natively — they round-trip as objects
   keyed by stringified indices. normalizeChecklist handles both shapes
   so we can read defensively regardless of how the data was last
   written. Tasks without a checklist field return [].
   ========================================================================= */

function normalizeChecklist(raw) {
	if (!raw) return [];
	// Already an array (newly written): copy and validate item shape.
	if (Array.isArray(raw)) {
		return raw
			.filter(it => it && typeof it === 'object')
			.map(it => ({ text: String(it.text || ''), done: !!it.done }));
	}
	// Firebase-style object with numeric-string keys: collect, sort, then map.
	if (typeof raw === 'object') {
		return Object.keys(raw)
			.sort((a, b) => Number(a) - Number(b))
			.map(k => raw[k])
			.filter(it => it && typeof it === 'object')
			.map(it => ({ text: String(it.text || ''), done: !!it.done }));
	}
	return [];
}

function getChecklist(taskId) {
	const task = currentTasks[taskId];
	return task ? normalizeChecklist(task.checklist) : [];
}

function saveChecklist(taskId, items) {
	// Strip empty-text items on save — they shouldn't persist. Done flag
	// on an empty item is meaningless. Adding a new item is non-empty by
	// design (we don't write until they type).
	const cleaned = items
		.filter(it => (it.text || '').trim() !== '')
		.map(it => ({ text: it.text.trim(), done: !!it.done }));

	// Firebase: writing an empty array writes nothing (the field is
	// removed). Use null explicitly to remove the field, otherwise write
	// the array.
	const value = cleaned.length === 0 ? null : cleaned;
	return tasksRef.child(taskId).child('checklist').set(value).catch(err => {
		console.error('checklist save failed:', err);
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
   New task creation
   -------------------------------------------------------------------------
   Tap the FAB → create a Firebase task with empty subject, due tomorrow,
   then auto-open the edit UI on it once the live listener brings it back
   into render(). If the user closes the edit UI without entering a
   subject, the task is removed to avoid leaving empty drafts behind.
   ========================================================================= */

function tomorrowIso() {
	const t = new Date();
	t.setDate(t.getDate() + 1);
	return isoDate(t);
}

function createNewTask() {
	const newRef = tasksRef.push();
	const id = newRef.key;

	newlyCreatedIds.add(id);
	pendingEditId = id;

	newRef.set({
		subject: '',
		project: '',
		due_date: tomorrowIso(),
		done: false
	}).catch(err => {
		console.error('createNewTask failed:', err);
		newlyCreatedIds.delete(id);
		pendingEditId = null;
	});
}

// Called when an edit session ends. If the task was just created via
// the FAB and the user didn't enter a subject, delete it so it doesn't
// linger as an empty row.
function cleanupEmptyNewTask(id, finalSubject) {
	if (!newlyCreatedIds.has(id)) return;
	newlyCreatedIds.delete(id);
	if (!finalSubject || !finalSubject.trim()) {
		tasksRef.child(id).remove().catch(err => {
			console.error('cleanup failed:', err);
		});
	}
}

document.getElementById('fabAdd').addEventListener('click', createNewTask);

/* =========================================================================
   Snooze (swipe right to +1 day)
   -------------------------------------------------------------------------
   Pointer events unify touch + mouse. On pointerdown, we wait for the
   first 8px of movement to decide intent: if it's clearly rightward and
   horizontal, we capture the pointer and start dragging; otherwise we
   release and let the page scroll. Past the 80px threshold the row
   commits (slides off, snoozes); under it, the row springs back.

   isSwiping suppresses live-listener re-renders during the gesture so
   the in-flight DOM isn't yanked away mid-drag.
   ========================================================================= */

const SNOOZE_THRESHOLD_PX = 80;
const SWIPE_AXIS_DEADZONE_PX = 8;

function snoozeOneDay(id) {
	const task = currentTasks[id];
	if (!task) return;
	let newDate;
	if (task.due_date) {
		// Increment existing due date by one day.
		const d = new Date(task.due_date + 'T00:00:00');
		d.setDate(d.getDate() + 1);
		newDate = isoDate(d);
	} else {
		// Tasks with no due date: setting to tomorrow is the sensible
		// "snooze" — gives the task a slot in the schedule.
		newDate = tomorrowIso();
	}
	updateField(id, { due_date: newDate });
}

function attachSwipeHandlers(taskEl, id) {
	let startX = 0, startY = 0, dx = 0;
	let phase = 'idle';            // 'idle' | 'pending' | 'dragging'
	let activePointerId = null;

	const reset = () => {
		phase = 'idle';
		activePointerId = null;
		dx = 0;
	};

	taskEl.addEventListener('pointerdown', (e) => {
		if (phase !== 'idle') return;
		if (e.button !== undefined && e.button !== 0) return;   // primary button only
		// Don't start swipes from interactive children — those have their
		// own handlers (checkbox toggle, edit button, notes editor).
		if (e.target.closest('.task-check, .task-edit, .task-notes-indicator, .task-checklist-indicator, .task-input, .task-notes-editor, .task-checklist-editor')) return;
		// Already in edit mode? No swipe.
		if (taskEl.classList.contains('is-editing')) return;

		startX = e.clientX;
		startY = e.clientY;
		dx = 0;
		phase = 'pending';
		activePointerId = e.pointerId;
	});

	taskEl.addEventListener('pointermove', (e) => {
		if (e.pointerId !== activePointerId) return;
		const cdx = e.clientX - startX;
		const cdy = e.clientY - startY;

		if (phase === 'pending') {
			// Wait for a non-trivial move before deciding axis.
			if (Math.abs(cdx) < SWIPE_AXIS_DEADZONE_PX &&
			    Math.abs(cdy) < SWIPE_AXIS_DEADZONE_PX) return;

			// Right-swipe only: horizontal, rightward.
			if (cdx > 0 && Math.abs(cdx) > Math.abs(cdy)) {
				phase = 'dragging';
				isSwiping = true;
				try { taskEl.setPointerCapture(activePointerId); } catch (_) {}
				taskEl.classList.add('is-swiping');
			} else {
				// Vertical (page scroll) or leftward — abandon.
				reset();
				return;
			}
		}

		if (phase === 'dragging') {
			dx = Math.max(0, cdx);
			taskEl.style.transform = `translateX(${dx}px)`;
			taskEl.classList.toggle('is-snooze-ready', dx >= SNOOZE_THRESHOLD_PX);
			e.preventDefault();
		}
	});

	const endDrag = (e) => {
		if (e.pointerId !== activePointerId) return;
		if (phase !== 'dragging') { reset(); return; }

		const committed = dx >= SNOOZE_THRESHOLD_PX;
		taskEl.classList.remove('is-swiping', 'is-snooze-ready');
		try { taskEl.releasePointerCapture(activePointerId); } catch (_) {}

		if (committed) {
			// Slide off + fade, then snooze. Live listener re-renders
			// the list with the task in its new position.
			taskEl.classList.add('is-swipe-commit');
			taskEl.style.transform = 'translateX(120%)';
			setTimeout(() => {
				// Clear isSwiping BEFORE the write. Firebase's local
				// cache fires the listener synchronously on .update(),
				// so if isSwiping were still true we'd suppress the
				// re-render that should reposition the task.
				isSwiping = false;
				snoozeOneDay(id);
			}, 240);
		} else {
			// Spring back. Clear inline transform so the row returns to its
			// resting position, then drop the transition class.
			taskEl.classList.add('is-swipe-resetting');
			taskEl.style.transform = '';
			setTimeout(() => {
				taskEl.classList.remove('is-swipe-resetting');
				isSwiping = false;
			}, 230);
		}
		// phase will be reset by reset() below; clear pointer state now.
		phase = 'idle';
		activePointerId = null;
		dx = 0;
	};

	taskEl.addEventListener('pointerup', endDrag);
	taskEl.addEventListener('pointercancel', endDrag);
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
let sheetChecklistEditor = null;

/* =========================================================================
   Checklist editor
   -------------------------------------------------------------------------
   Shared by both the mobile sheet and the desktop inline editor. Given a
   container element and a task id, builds an editable list with:
   - tick checkbox per item (toggles done, strikes through text)
   - text input per item
   - up/down arrows to reorder
   - × to delete
   - "+ Add item" row at the bottom

   Keeps a local `items` array as the source of truth during editing.
   Returns a getItems() function so the caller can persist on save.
   ========================================================================= */

function buildChecklistEditor(container, taskId) {
	let items = getChecklist(taskId);

	// Persistent textarea-style behavior: writes to Firebase happen on
	// blur/change of each input (autosave). Reordering, toggling, adding,
	// and deleting all write immediately. The 'isEditing' flag suppresses
	// the live-listener re-render so these writes don't yank our inputs.
	const rebuild = () => {
		container.innerHTML = '';
		container.appendChild(renderList());
	};

	const persist = () => {
		// Write the current local state. The live listener will echo
		// back but is suppressed by isEditing.
		saveChecklist(taskId, items);
	};

	function renderList() {
		const wrap = document.createElement('div');
		wrap.className = 'cl-list';

		items.forEach((it, idx) => {
			wrap.appendChild(renderRow(it, idx));
		});

		// "+ Add item" row stays at the bottom.
		const addBtn = document.createElement('button');
		addBtn.type = 'button';
		addBtn.className = 'cl-add';
		addBtn.innerHTML = `
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
				<line x1="12" y1="5" x2="12" y2="19"/>
				<line x1="5" y1="12" x2="19" y2="12"/>
			</svg>
			<span>Add item</span>
		`;
		addBtn.addEventListener('click', () => {
			items.push({ text: '', done: false });
			rebuild();
			// Focus the new item's text input immediately.
			const lastInput = wrap.parentElement
				? wrap.parentElement.querySelector('.cl-list .cl-row:last-of-type .cl-text')
				: null;
			if (lastInput) lastInput.focus();
		});
		wrap.appendChild(addBtn);

		return wrap;
	}

	function renderRow(it, idx) {
		const row = document.createElement('div');
		row.className = 'cl-row' + (it.done ? ' is-done' : '');

		const check = document.createElement('button');
		check.type = 'button';
		check.className = 'cl-check';
		check.setAttribute('aria-label', 'Toggle done');
		check.setAttribute('aria-pressed', String(!!it.done));
		check.addEventListener('click', () => {
			items[idx].done = !items[idx].done;
			row.classList.toggle('is-done', items[idx].done);
			check.setAttribute('aria-pressed', String(items[idx].done));
			persist();
		});

		const text = document.createElement('input');
		text.type = 'text';
		text.className = 'cl-text';
		text.value = it.text;
		text.placeholder = 'Item';
		text.addEventListener('input', () => {
			// Update local state on every keystroke (so reorder picks up
			// in-flight text), but only write on blur to avoid spamming
			// Firebase with one write per character.
			items[idx].text = text.value;
		});
		text.addEventListener('change', persist);
		text.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				// Enter at end of an item creates a new item below.
				items[idx].text = text.value;
				items.splice(idx + 1, 0, { text: '', done: false });
				persist();
				rebuild();
				// Focus the newly inserted item.
				const rows = container.querySelectorAll('.cl-row .cl-text');
				if (rows[idx + 1]) rows[idx + 1].focus();
			} else if (e.key === 'Escape') {
				text.blur();
			}
		});

		// Reorder controls: up + down arrows. Disabled at boundaries.
		const upBtn = document.createElement('button');
		upBtn.type = 'button';
		upBtn.className = 'cl-move';
		upBtn.setAttribute('aria-label', 'Move up');
		upBtn.disabled = idx === 0;
		upBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 15 12 9 6 15"/></svg>`;
		upBtn.addEventListener('click', () => {
			if (idx === 0) return;
			[items[idx - 1], items[idx]] = [items[idx], items[idx - 1]];
			persist();
			rebuild();
		});

		const downBtn = document.createElement('button');
		downBtn.type = 'button';
		downBtn.className = 'cl-move';
		downBtn.setAttribute('aria-label', 'Move down');
		downBtn.disabled = idx === items.length - 1;
		downBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>`;
		downBtn.addEventListener('click', () => {
			if (idx === items.length - 1) return;
			[items[idx + 1], items[idx]] = [items[idx], items[idx + 1]];
			persist();
			rebuild();
		});

		const del = document.createElement('button');
		del.type = 'button';
		del.className = 'cl-delete';
		del.setAttribute('aria-label', 'Delete item');
		del.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
		del.addEventListener('click', () => {
			items.splice(idx, 1);
			persist();
			rebuild();
		});

		row.appendChild(check);
		row.appendChild(text);
		row.appendChild(upBtn);
		row.appendChild(downBtn);
		row.appendChild(del);

		return row;
	}

	container.innerHTML = '';
	container.appendChild(renderList());

	// Caller can read the final state when committing the parent editor.
	return { getItems: () => items, persist };
}

function openEditSheet(id) {
	const task = currentTasks[id];
	if (!task) return;

	sheetTaskId = id;
	sheetReturnFocusEl = document.activeElement;

	document.getElementById('sheetSubject').value = task.subject  || '';
	document.getElementById('sheetProject').value = task.project  || '';
	document.getElementById('sheetDate').value    = task.due_date || '';
	// due_time and notes are optional — older tasks in Firebase may not
	// have either field. `|| ''` collapses missing/null/undefined to empty.
	document.getElementById('sheetTime').value    = task.due_time || '';
	document.getElementById('sheetNotes').value   = task.notes    || '';

	// Build the checklist editor. The autosave-on-blur pattern in the
	// editor means we don't need to capture a reference here — but
	// closing the sheet calls persist() one final time to flush any
	// in-flight text changes.
	const checklistContainer = document.getElementById('sheetChecklist');
	sheetChecklistEditor = buildChecklistEditor(checklistContainer, id);

	const backdrop = document.getElementById('sheetBackdrop');
	const sheet    = document.getElementById('sheet');

	clearTimeout(sheetCloseTimerId);
	backdrop.hidden = false;
	sheet.hidden = false;

	// Force reflow so the slide-up animation actually runs from translateY(100%).
	void sheet.offsetWidth;
	backdrop.classList.add('is-visible');
	sheet.classList.add('is-visible');

	// Focus the subject after the slide-up settles. Cursor goes to the
	// end of the existing text — placing the caret at end is the usual
	// "edit, don't replace" expectation, especially on mobile where
	// select-all immediately followed by a tap-character wipes the field.
	setTimeout(() => {
		const input = document.getElementById('sheetSubject');
		input.focus();
		const len = input.value.length;
		try { input.setSelectionRange(len, len); } catch (_) {}
	}, 340);
}

function closeEditSheet({ save = true } = {}) {
	if (!sheetTaskId) return;

	const id = sheetTaskId;

	// Capture final subject before commit so we can decide whether a
	// just-created task should be auto-deleted.
	const subjectInput = document.getElementById('sheetSubject');
	const finalSubject = subjectInput ? subjectInput.value : '';

	if (save) commitEditSheet();

	// Flush any in-flight text edits in the checklist editor. Toggle/
	// reorder/delete autosave, but a partially-typed text input may not
	// have fired its 'change' event yet.
	if (sheetChecklistEditor) {
		sheetChecklistEditor.persist();
		sheetChecklistEditor = null;
	}

	cleanupEmptyNewTask(id, finalSubject);

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
	const newTime    = document.getElementById('sheetTime').value;
	// Notes: keep internal whitespace but trim leading/trailing — paragraph
	// breaks inside the note are preserved.
	const newNotes   = document.getElementById('sheetNotes').value.trim();

	// Diff against the existing values so we don't write no-op updates
	// (which would still trigger the live listener and re-render).
	const updates = {};
	if (newSubject !== (task.subject  || '')) updates.subject  = newSubject;
	if (newProject !== (task.project  || '')) updates.project  = newProject;
	if (newDate    !== (task.due_date || '')) updates.due_date = newDate;
	if (newTime    !== (task.due_time || '')) updates.due_time = newTime;
	if (newNotes   !== (task.notes    || '')) updates.notes    = newNotes;

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
	const timeEl    = row.querySelector('.task-time');   // may be null

	const subjectVal = subjectEl ? subjectEl.textContent.trim() : '';
	const projectVal = projectEl ? projectEl.textContent.trim() : '';
	const dueVal     = (dueEl && dueEl.dataset.iso) ? dueEl.dataset.iso : '';
	// Read notes + time from source of truth — time may not render in
	// the row, and even when it does we want HH:MM not the formatted
	// version (formatting is identical here but data-* is canonical).
	const notesVal   = (currentTasks[id] && currentTasks[id].notes) || '';
	const timeVal    = (currentTasks[id] && currentTasks[id].due_time) || '';

	subjectEl.outerHTML =
		`<input class="task-input" type="text" id="subject${id}" value="${escapeHtml(subjectVal)}">`;
	projectEl.outerHTML =
		`<input class="task-input task-input--mono task-input--project" list="listProjects" id="project${id}" value="${escapeHtml(projectVal)}" placeholder="Project">`;
	dueEl.outerHTML =
		`<input class="task-input task-input--mono task-input--date" type="date" id="due${id}" value="${escapeHtml(dueVal)}">`;

	// Replace or remove the optional time chip. It may not exist in the
	// DOM (only rendered when due_time is set), so we insert next to the
	// date input either way to keep layout consistent during editing.
	if (timeEl) timeEl.remove();
	const newDateInput = document.getElementById("due" + id);
	const timeInput = document.createElement('input');
	timeInput.type = 'time';
	timeInput.className = 'task-input task-input--mono task-input--time';
	timeInput.id = 'time' + id;
	timeInput.value = timeVal;
	timeInput.lang = 'en-GB';            // force 24h display
	timeInput.placeholder = '—';
	newDateInput.insertAdjacentElement('afterend', timeInput);

	// Append a notes editor row spanning the whole grid. Built as a
	// separate element (not outerHTML) so we can attach the change
	// listener directly without an id lookup.
	const notesWrap = document.createElement('div');
	notesWrap.className = 'task-notes-editor';
	const notesTa = document.createElement('textarea');
	notesTa.className = 'task-input task-input--notes';
	notesTa.id = 'notes' + id;
	notesTa.placeholder = 'Notes';
	notesTa.rows = 3;
	notesTa.value = notesVal;
	notesWrap.appendChild(notesTa);
	row.appendChild(notesWrap);

	// Inline checklist editor as a second full-width row after notes.
	// Same buildChecklistEditor() as the sheet — single source of truth.
	const checklistWrap = document.createElement('div');
	checklistWrap.className = 'task-checklist-editor';
	const checklistLabel = document.createElement('div');
	checklistLabel.className = 'task-checklist-label';
	checklistLabel.textContent = 'Checklist';
	const checklistInner = document.createElement('div');
	checklistWrap.appendChild(checklistLabel);
	checklistWrap.appendChild(checklistInner);
	row.appendChild(checklistWrap);
	const inlineChecklistEditor = buildChecklistEditor(checklistInner, id);
	row.__inlineChecklistEditor = inlineChecklistEditor;

	const subjectInput = document.getElementById("subject" + id);
	const projectInput = document.getElementById("project" + id);
	const dueInput     = document.getElementById("due" + id);

	subjectInput.addEventListener("change", () => updateField(id, { subject: subjectInput.value }));
	projectInput.addEventListener("change", () => updateField(id, { project: projectInput.value }));
	dueInput.addEventListener("change",     () => updateField(id, { due_date: dueInput.value }));
	timeInput.addEventListener("change", () => {
		const newTime = timeInput.value;
		const oldTime = (currentTasks[id] && currentTasks[id].due_time) || '';
		if (newTime !== oldTime) updateField(id, { due_time: newTime });
	});
	// Notes save on blur (which is when 'change' fires for textareas).
	notesTa.addEventListener("change", () => {
		const newNotes = notesTa.value.trim();
		const oldNotes = (currentTasks[id] && currentTasks[id].notes) || '';
		if (newNotes !== oldNotes) updateField(id, { notes: newNotes });
	});

	row.addEventListener("focusout", () => {
		setTimeout(() => {
			if (!row.contains(document.activeElement)) {
				isEditing = false;
				// Read the input directly (not currentTasks, which may not
				// have echoed back the latest typed value yet).
				const subjectInputEl = document.getElementById("subject" + id);
				const finalSubject = subjectInputEl ? subjectInputEl.value : '';
				// Flush any in-flight checklist text edits before render().
				if (row.__inlineChecklistEditor) {
					row.__inlineChecklistEditor.persist();
				}
				cleanupEmptyNewTask(id, finalSubject);
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
	timeInput.addEventListener("keydown", commitOnEnter);
	// Escape blurs the notes textarea (committing change, exiting edit).
	// Enter inside the textarea adds a newline as expected.
	notesTa.addEventListener("keydown", (e) => {
		if (e.key === "Escape") notesTa.blur();
	});

	subjectInput.focus();
	// Cursor at end of existing text — see openEditSheet for rationale.
	const subLen = subjectInput.value.length;
	try { subjectInput.setSelectionRange(subLen, subLen); } catch (_) {}
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
	// iOS Safari restores scroll position AFTER our handler fires on
	// rotation, undoing a single reset. Fire reset at multiple timings
	// (now, next frame, post-settle) to win the race. The repeated
	// resets are no-ops if the user hasn't scrolled in between.
	resetAllScrolls();
	requestAnimationFrame(resetAllScrolls);
	setTimeout(resetAllScrolls, 100);
	setTimeout(resetAllScrolls, 350);
});

// Also listen to orientationchange directly. matchMedia 'change' fires
// at media-query flip time, but orientationchange fires after layout
// settles — a better moment to scroll-reset.
window.addEventListener('orientationchange', () => {
	requestAnimationFrame(resetAllScrolls);
	setTimeout(resetAllScrolls, 100);
});

function resetAllScrolls() {
	// Window scroll (portrait list lives here — .task-list has no
	// overflow, so the body itself is the scroll container).
	window.scrollTo(0, 0);
	document.documentElement.scrollTop = 0;
	document.body.scrollTop = 0;

	// Pager: back to first page (week view).
	const pager = document.getElementById('landscapePager');
	if (pager) pager.scrollLeft = 0;

	resetInnerScrolls();
}

// Reset vertical scrolls inside week-day columns and kanban columns,
// plus the kanban page's horizontal scroll strip.
function resetInnerScrolls() {
	document.querySelectorAll('.week-day-tasks, .kanban-column-tasks').forEach(el => {
		el.scrollTop = 0;
	});
	const kanbanScroll = document.getElementById('kanbanScroll');
	if (kanbanScroll) kanbanScroll.scrollLeft = 0;
}

// Track which page is active so the dot indicator stays in sync.
// Updated via scroll listener (debounced via rAF) on the pager. We also
// reset inner scroll positions when the active page changes, so e.g.
// swiping from week → kanban starts kanban at the leftmost column.
{
	const pager = document.getElementById('landscapePager');
	if (pager) {
		let raf = null;
		let lastActivePage = 0;
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
				if (activePage !== lastActivePage) {
					lastActivePage = activePage;
					// Reset inner scrolls now and once more after the
					// snap settles. The snap animation is ~250ms on iOS;
					// resetting after gives a clean starting state even
					// if the destination page had stale scroll positions.
					resetInnerScrolls();
					setTimeout(resetInnerScrolls, 300);
				}
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

	// Concatenate time after subject if present: "Review docket 14:30".
	// Older tasks without a due_time field render as just the subject.
	const subjectText = (task.subject || '') +
		(task.due_time ? ` ${task.due_time}` : '');

	return `<button class="lv-task ${stateClass}" type="button" data-id="${escapeHtml(id)}" title="${escapeHtml(subjectText)}">
		<span class="lv-task-subject">${escapeHtml(subjectText)}</span>
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

	// Sort each column: by due_date then due_time, undated tasks last.
	const sortIds = (taskIds) => taskIds.sort(compareTasksByDueDateTime);

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

/* =========================================================================
   Notes popover
   -------------------------------------------------------------------------
   Tap the notes icon on a task row → show the notes text in a small
   floating popover anchored to the icon. Single popover instance lives
   in document.body, positioned absolutely. Dismisses on outside-click,
   Escape, scroll, resize, or another popover-open.
   ========================================================================= */

let openNotesPopover = null;        // { btn, id, el } or null

function toggleNotesPopover(btn, id) {
	if (openNotesPopover && openNotesPopover.btn === btn) {
		closeNotesPopover();
		return;
	}
	openNotesPopover && closeNotesPopover();
	openNotesPopoverFor(btn, id);
}

function openNotesPopoverFor(btn, id) {
	const task = currentTasks[id];
	if (!task) return;
	const notes = (task.notes || '').trim();
	if (!notes) return;

	const pop = document.createElement('div');
	pop.className = 'notes-popover';
	pop.setAttribute('role', 'dialog');
	pop.setAttribute('aria-label', 'Notes');

	const content = document.createElement('div');
	content.className = 'notes-popover-content';
	// textContent preserves linebreaks-as-newlines; CSS white-space: pre-wrap
	// renders them as visible line breaks.
	content.textContent = notes;
	pop.appendChild(content);

	document.body.appendChild(pop);
	btn.setAttribute('aria-expanded', 'true');

	positionNotesPopover(pop, btn);

	openNotesPopover = { btn, id, el: pop };

	// Defer attaching dismiss listeners by a tick so the click that
	// opened us doesn't immediately close us via document handler.
	setTimeout(() => {
		document.addEventListener('pointerdown', onDocumentPointerDownForPopover, true);
		document.addEventListener('keydown', onPopoverKey, true);
		window.addEventListener('scroll', closeNotesPopover, true);
		window.addEventListener('resize', closeNotesPopover);
	}, 0);
}

function closeNotesPopover() {
	if (!openNotesPopover) return;
	const { btn, el } = openNotesPopover;
	openNotesPopover = null;

	btn.setAttribute('aria-expanded', 'false');
	el.remove();

	document.removeEventListener('pointerdown', onDocumentPointerDownForPopover, true);
	document.removeEventListener('keydown', onPopoverKey, true);
	window.removeEventListener('scroll', closeNotesPopover, true);
	window.removeEventListener('resize', closeNotesPopover);
}

function onDocumentPointerDownForPopover(e) {
	if (!openNotesPopover) return;
	if (e.target.closest('.notes-popover')) return;          // tap inside popover stays open
	if (e.target.closest('.task-notes-indicator')) return;   // let toggle decide
	closeNotesPopover();
}

function onPopoverKey(e) {
	if (e.key === 'Escape') closeNotesPopover();
}

function positionNotesPopover(pop, btn) {
	// Anchor the popover to the indicator button. Default: below + to the
	// right of the icon. If that overflows the viewport, reflect across
	// axes so it stays on-screen.
	const PAD = 8;
	const VIEWPORT_PAD = 12;
	const btnRect = btn.getBoundingClientRect();

	// Render at 0,0 first to measure the popover's natural size.
	pop.style.left = '0px';
	pop.style.top = '0px';
	const popRect = pop.getBoundingClientRect();

	let top = btnRect.bottom + PAD;
	let left = btnRect.left;

	// Flip up if not enough room below.
	if (top + popRect.height > window.innerHeight - VIEWPORT_PAD) {
		top = Math.max(VIEWPORT_PAD, btnRect.top - PAD - popRect.height);
	}
	// Slide left if overflowing right edge.
	if (left + popRect.width > window.innerWidth - VIEWPORT_PAD) {
		left = Math.max(VIEWPORT_PAD, window.innerWidth - VIEWPORT_PAD - popRect.width);
	}

	pop.style.left = `${left + window.scrollX}px`;
	pop.style.top  = `${top  + window.scrollY}px`;
}

function render() {
	// Re-rendering rebuilds the task rows, so the indicator button the
	// popover is anchored to will be destroyed. Close it pre-emptively.
	if (openNotesPopover) closeNotesPopover();
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

	ids.sort(compareTasksByDueDateTime);

	taskBody.innerHTML = '';

	ids.forEach((id, i) => {
		const task = currentTasks[id];
		const due = formatDue(task.due_date);

		const row = document.createElement('div');
		row.className = `task ${due.state}`.trim();
		row.id = id;
		row.style.animationDelay = `${Math.min(i * 25, 250)}ms`;

		// Show a small notes indicator if the task has any non-whitespace
		// notes content. Older tasks may not have a `notes` field at all.
		const hasNotes = ((task.notes || '').trim() !== '');
		const notesIndicator = hasNotes
			? `<button class="task-notes-indicator" type="button" data-notes-for="${escapeHtml(id)}" aria-label="Show notes" aria-expanded="false">
				<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/></svg>
			</button>`
			: '';

		// Compact checklist counter: shown only when checklist is non-empty.
		const checklist = normalizeChecklist(task.checklist);
		const checklistIndicator = checklist.length > 0
			? `<span class="task-checklist-indicator" aria-label="${checklist.filter(it => it.done).length} of ${checklist.length} done">${checklist.filter(it => it.done).length}/${checklist.length}</span>`
			: '';

		// Optional time chip after the subject. Tasks without due_time
		// render no chip at all (no element, no whitespace).
		const timeStr = task.due_time || '';
		const timeChip = timeStr
			? `<span class="task-time">${escapeHtml(timeStr)}</span>`
			: '';

		row.innerHTML = `
			<button class="task-check" type="button" id="done${id}" aria-label="Mark done"></button>
			<div class="task-content">
				<div class="task-subject">${escapeHtml(task.subject || '')}</div>
				${timeChip}
				${notesIndicator}
				${checklistIndicator}
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
		attachSwipeHandlers(row, id);

		const notesBtn = row.querySelector('.task-notes-indicator');
		if (notesBtn) {
			notesBtn.addEventListener('click', (e) => {
				// Don't let the click bubble to swipe handlers or open
				// the edit sheet — popover is a peer interaction.
				e.stopPropagation();
				toggleNotesPopover(notesBtn, id);
			});
		}
	});

	// If a task was just created via the FAB, open its editor now that
	// the row is in the DOM. Done after the loop so all rows are wired.
	if (pendingEditId && document.getElementById(pendingEditId)) {
		const id = pendingEditId;
		pendingEditId = null;
		// Defer one tick so any in-flight render work settles first.
		setTimeout(() => setEditMode(id), 0);
	}
}
