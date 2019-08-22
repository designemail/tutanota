//@flow
import {lang} from "../misc/LanguageViewModel"
import {makeInvitationCalendarFile} from "./CalendarImporter"
import type {CalendarAttendeeStatusEnum, CalendarMethodEnum} from "../api/common/TutanotaConstants"
import {CalendarMethod, ConversationType, getAttendeeStatus} from "../api/common/TutanotaConstants"
import {calendarAttendeeStatusSymbol, formatEventDuration, getTimeZone} from "./CalendarUtils"
import type {CalendarEvent} from "../api/entities/tutanota/CalendarEvent"
import type {MailAddress} from "../api/entities/tutanota/MailAddress"
import {stringToUtf8Uint8Array, uint8ArrayToBase64} from "../api/common/utils/Encoding"
import {theme} from "../gui/theme"
import {assertNotNull, noOp} from "../api/common/utils/Utils"
import type {EncryptedMailAddress} from "../api/entities/tutanota/EncryptedMailAddress"
import {SendMailModel} from "../mail/SendMailModel"
import {show} from "../gui/base/NotificationOverlay"
import m from "mithril"
import type {Mail} from "../api/entities/tutanota/Mail"
import {windowFacade} from "../misc/WindowFacade"

export interface CalendarUpdateDistributor {
	sendInvite(existingEvent: CalendarEvent, sendMailModel: SendMailModel): Promise<void>;

	sendUpdate(event: CalendarEvent, sendMailModel: SendMailModel): Promise<void>;

	sendCancellation(event: CalendarEvent, sendMailModel: SendMailModel): Promise<void>;

	sendResponse(event: CalendarEvent, sendMailModel: SendMailModel, sendAs: string, responseTo: ?Mail, status: CalendarAttendeeStatusEnum
	): Promise<void>;
}

export class CalendarMailDistributor implements CalendarUpdateDistributor {
	/** Used for knowing how many emails are in the process of being sent. */
	_countDownLatch: number;

	constructor() {
		this._countDownLatch = 0
	}

	sendInvite(event: CalendarEvent, sendMailModel: SendMailModel): Promise<void> {
		const message = lang.get("eventInviteMail_msg", {"{event}": event.summary})
		return this._sendCalendarFile({
			sendMailModel,
			method: CalendarMethod.REQUEST,
			subject: message,
			body: makeInviteEmailBody(event, message),
			event,
			sender: assertOrganizer(event).address
		})
	}

	sendUpdate(event: CalendarEvent, sendMailModel: SendMailModel): Promise<void> {
		return this._sendCalendarFile({
			sendMailModel,
			method: CalendarMethod.REQUEST,
			subject: lang.get("eventUpdated_msg", {"{event}": event.summary}),
			body: makeInviteEmailBody(event, ""),
			event,
			sender: assertOrganizer(event).address
		}).then(() => {
			const closeSent = show({view: () => m("", lang.get("updateSent_msg"))}, {}, [])
			setTimeout(closeSent, 3000)
		})
	}

	sendCancellation(event: CalendarEvent, sendMailModel: SendMailModel): Promise<void> {
		const message = lang.get("eventCancelled_msg", {"{event}": event.summary})
		return this._sendCalendarFile({
			sendMailModel,
			method: CalendarMethod.CANCEL,
			subject: message,
			body: makeInviteEmailBody(event, message),
			event,
			sender: assertOrganizer(event).address
		})
	}

	sendResponse(event: CalendarEvent, sendMailModel: SendMailModel, sendAs: string, responseTo: ?Mail, status: CalendarAttendeeStatusEnum
	): Promise<void> {
		const message = lang.get("repliedToEventInvite_msg", {"{sender}": sendAs, "{event}": event.summary})
		const body = makeInviteEmailBody(event, message)
		const organizer = assertOrganizer(event)
		if (responseTo) {
			return Promise.resolve()
			              .then(() => {
				              this._sendStart()
				              return sendMailModel.initAsResponse({
					              previousMail: responseTo,
					              conversationType: ConversationType.REPLY,
					              senderMailAddress: sendAs,
					              recipients: {to: [{name: organizer.name, address: organizer.address}]},
					              attachments: [],
					              bodyText: body,
					              subject: message,
					              addSignature: false,
					              blockExternalContent: false,
					              replyTos: [],
				              })
			              })
			              .then(() => {
				              sendMailModel.attachFiles([makeInvitationCalendarFile(event, CalendarMethod.REPLY, new Date(), getTimeZone())])
				              return sendMailModel.send(body, CalendarMethod.REPLY)
			              })
			              .finally(() => this._sendEnd())
		} else {
			return this._sendCalendarFile({sendMailModel, method: CalendarMethod.REPLY, subject: message, body, event, sender: sendAs})
		}
	}

	_sendCalendarFile({sendMailModel, method, subject, event, body, sender}: {
		sendMailModel: SendMailModel,
		method: CalendarMethodEnum,
		subject: string,
		event: CalendarEvent,
		body: string,
		sender: string
	}): Promise<void> {
		const inviteFile = makeInvitationCalendarFile(event, method, new Date(), getTimeZone())
		sendMailModel.selectSender(sender)
		sendMailModel.attachFiles([inviteFile])
		sendMailModel.setSubject(subject)
		this._sendStart()
		return sendMailModel.send(body, method)
		                    .finally(() => this._sendEnd())
	}

	_windowUnsubscribe: ?(() => void)

	_sendStart() {
		this._countDownLatch++
		if (this._countDownLatch === 1) {
			this._windowUnsubscribe = windowFacade.addWindowCloseListener(noOp)
		}
	}

	_sendEnd() {
		this._countDownLatch--
		if (this._countDownLatch === 0 && this._windowUnsubscribe) {
			this._windowUnsubscribe()
			this._windowUnsubscribe = null
		}
	}
}

function organizerLine(event: CalendarEvent) {
	const {organizer} = event
	// If organizer is already in the attendees, we don't have to add them separately.
	if (organizer && event.attendees.find((a) => a.address.address === organizer.address)) {
		return ""
	}
	return `<div style="display: flex"><div style="min-width: 80px">${lang.get("who_label")}:</div><div>${
		organizer ? `${organizer.name || ""} ${organizer.address} </EXTERNAL_FRAGMENT> (${lang.get("organizer_label")})` : ""}</div></div>`
}

function whenLine(event: CalendarEvent): string {
	const duration = formatEventDuration(event, getTimeZone())
	return `<div style="display: flex"><div style="min-width: 80px">${lang.get("when_label")}:</div>${duration}</div>`
}

function organizerLabel(event, a) {
	return assertNotNull(event.organizer) === a.address.address ? `(${lang.get("organizer_label")})` : ""
}

function makeInviteEmailBody(event: CalendarEvent, message: string) {
	return `<div style="max-width: 685px; margin: 0 auto">
  <h2 style="text-align: center">${message}</h2>
  <div style="margin: 0 auto">
    ${whenLine(event)}
    ${organizerLine(event)}
    ${event.attendees.map((a) =>
		`<div style='margin-left: 80px'>
${a.address.name || ""} ${a.address.address}
${(organizerLabel(event, a))}
${calendarAttendeeStatusSymbol(getAttendeeStatus(a))}</div>`)
	       .join("\n")}
  </div>
  <hr style="border: 0; height: 1px; background-color: #ddd">
  <img style="max-height: 38px; display: block; background-color: white; padding: 4px 8px; border-radius: 4px; margin: 16px auto 0"
  		src="data:image/svg+xml;base64,${uint8ArrayToBase64(stringToUtf8Uint8Array(theme.logo))}"
  		alt="logo"/>
</div>`
}

function makeResponseEmailBody(event: CalendarEvent, message: string, sender: MailAddress, status: CalendarAttendeeStatusEnum): string {
	return `<div style="max-width: 685px; margin: 0 auto">
  <h2 style="text-align: center">${message}</h2>
  <div style="margin: 0 auto">
  <div style="display: flex">${lang.get("who_label")}:<div style='margin-left: 80px'>${sender.name + " " + sender.address
	} ${calendarAttendeeStatusSymbol(status)}</div></div>
  </div>
  <hr style="border: 0; height: 1px; background-color: #ddd">
  <img style="max-height: 38px; display: block; background-color: white; padding: 4px 8px; border-radius: 4px; margin: 16px auto 0"
  		src="data:image/svg+xml;base64,${uint8ArrayToBase64(stringToUtf8Uint8Array(theme.logo))}"
  		alt="logo"/>
</div>`
}

function assertOrganizer(event: CalendarEvent): EncryptedMailAddress {
	if (event.organizer == null) {
		throw new Error("Cannot send event update without organizer")
	}
	return event.organizer
}

export const calendarUpdateDistributor: CalendarUpdateDistributor = new CalendarMailDistributor()