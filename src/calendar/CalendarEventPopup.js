//@flow
import type {Shortcut} from "../misc/KeyManager"
import m from "mithril"
import {px} from "../gui/size"
import {CALENDAR_EVENT_HEIGHT, getEventStart, getTimeZone} from "./CalendarUtils"
import {animations, opacity, transform} from "../gui/animation/Animations"
import {ease} from "../gui/animation/Easing"
import {ButtonColors, ButtonN, ButtonType} from "../gui/base/ButtonN"
import {Icons} from "../gui/base/icons/Icons"
import type {ModalComponent} from "../gui/base/Modal"
import {modal} from "../gui/base/Modal"
import {EventPreviewView} from "./EventPreviewView"
import type {CalendarEvent} from "../api/entities/tutanota/CalendarEvent"
import {Dialog} from "../gui/base/Dialog"
import {styles} from "../gui/styles"
import type {CalendarInfo} from "./CalendarView"
import {CalendarEventViewModel, createCalendarEventViewModel} from "./CalendarEventViewModel"
import type {MailboxDetail} from "../mail/MailModel"

export class CalendarEventPopup implements ModalComponent {
	_calendarEvent: CalendarEvent;
	_rect: ClientRect;
	_viewModel: CalendarEventViewModel;
	_onEditEvent: () => mixed;

	constructor(calendarEvent: CalendarEvent, calendars: Map<Id, CalendarInfo>, mailboxDetail: MailboxDetail, rect: ClientRect,
	            onEditEvent: () => mixed
	) {
		this._calendarEvent = calendarEvent
		this._rect = rect
		this._onEditEvent = onEditEvent
		if (calendarEvent._ownerGroup == null) {
			throw new Error("Tried to open popup with non-persistent calendar event")
		}
		const calendarInfo = calendars.get(calendarEvent._ownerGroup)
		if (calendarInfo == null) {
			throw new Error("Passed event from unknown calendar")
		}
		this._viewModel = createCalendarEventViewModel(getEventStart(calendarEvent, getTimeZone()), calendars, mailboxDetail, calendarEvent)
	}

	show() {
		if (styles.isDesktopLayout()) {
			modal.displayUnique(this, false)
		} else {
			showMobileDialog(this._viewModel, this._calendarEvent, () => this._onEditEvent())
		}
	}

	view(vnode: Vnode<any>) {
		return m(".abs.content-bg.plr.border-radius", {
				style: {
					width: "400px",
					boxShadow: "0 24px 38px 3px rgba(0,0,0,0.14),0 9px 46px 8px rgba(0,0,0,0.12),0 11px 15px -7px rgba(0,0,0,0.2)"
				},
				oncreate: ({dom}) => {
					const pos = this._rect
					if (pos.top < window.innerHeight / 2) {
						dom.style.top = px(pos.top + CALENDAR_EVENT_HEIGHT + 4)
					} else {
						dom.style.bottom = px(window.innerHeight - pos.top)
					}
					if (pos.left < window.innerWidth / 2) {
						dom.style.left = px(pos.left)
					} else {
						dom.style.right = px(window.innerWidth - pos.right)
					}
					animations.add(dom, [transform("translateX", -40, 0), opacity(0, 1, true)], {
						duration: 100,
						easing: ease.in
					})
				},
			},
			[
				m(".flex.flex-end", [
					m(ButtonN, {
						label: "edit_action",
						click: () => {
							this._onEditEvent()
							this._close()
						},
						type: ButtonType.ActionLarge,
						icon: () => Icons.Edit,
						colors: ButtonColors.DrawerNav,
					}),
					!this._viewModel.readOnly
						? m(ButtonN, {
							label: "delete_action",
							click: () => deleteEvent(this._viewModel).then((confirmed) => {
								if (confirmed) this._close()
							}),
							type: ButtonType.ActionLarge,
							icon: () => Icons.Trash,
							colors: ButtonColors.DrawerNav,
						})
						: null,
					m(ButtonN, {
						label: "close_alt",
						click: () => this._close(),
						type: ButtonType.ActionLarge,
						icon: () => Icons.Cancel,
						colors: ButtonColors.DrawerNav,
					}),
				]),
				m(EventPreviewView, {event: this._calendarEvent}),
			],
		)
	}

	_close() {
		modal.remove(this)
	}

	backgroundClick(e: MouseEvent): void {
		modal.remove(this)
	}

	hideAnimation() {
		return Promise.resolve()
	}

	onClose(): void {
	}

	shortcuts(): Shortcut[] {
		return []
	}

	popState(e: Event): boolean {
		return true
	}
}

function showMobileDialog(viewModel: CalendarEventViewModel, event: CalendarEvent, onEditEvent: () => mixed) {
	const dialog = Dialog.largeDialog({
		left: [
			{
				label: "close_alt",
				click: () => dialog.close(),
				type: ButtonType.ActionLarge,
				icon: () => Icons.Cancel,
				colors: ButtonColors.DrawerNav,
			},
		],
		right: [
			{
				label: "edit_action",
				click: () => {
					onEditEvent()
					dialog.close()
				},
				type: ButtonType.ActionLarge,
				icon: () => Icons.Edit,
				colors: ButtonColors.DrawerNav,
			}
		].concat(!viewModel.readOnly ? {
				label: "delete_action",
				click: () => deleteEvent(viewModel).then((confirmed) => {
					if (confirmed) dialog.close()
				}),
				type: ButtonType.ActionLarge,
				icon: () => Icons.Trash,
				colors: ButtonColors.DrawerNav,
			}
			: []
		)
	}, {
		view: () => m(".mt.pl-s.pr-s", m(EventPreviewView, {event}))
	}).show()
}

function deleteEvent(viewModel: CalendarEventViewModel): Promise<boolean> {
	return Dialog.confirm("deleteEventConfirmation_msg").then((confirmed) => {
		if (confirmed) {
			viewModel.deleteEvent()
		}
		return confirmed
	})
}