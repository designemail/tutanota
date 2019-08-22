//@flow
import {parseCalendarFile} from "./CalendarImporter"
import {worker} from "../api/main/WorkerClient"
import {showCalendarEventDialog} from "./CalendarEventEditDialog"
import type {CalendarEvent} from "../api/entities/tutanota/CalendarEvent"
import type {File as TutanotaFile} from "../api/entities/tutanota/File"
import {loadCalendarInfos} from "./CalendarModel"
import {locator} from "../api/main/MainLocator"
import type {CalendarEventAttendee} from "../api/entities/tutanota/CalendarEventAttendee"
import type {CalendarAttendeeStatusEnum} from "../api/common/TutanotaConstants"
import {assertNotNull, clone} from "../api/common/utils/Utils"
import {incrementSequence} from "./CalendarUtils"
import type {CalendarInfo} from "./CalendarView"
import {logins} from "../api/main/LoginController"
import {SendMailModel} from "../mail/SendMailModel"
import type {Mail} from "../api/entities/tutanota/Mail"
import {calendarUpdateDistributor} from "./CalendarUpdateDistributor"

function loadOrCreateCalendarInfo(): Promise<Map<Id, CalendarInfo>> {
	return loadCalendarInfos()
		.then((calendarInfo) => (!logins.isInternalUserLoggedIn() || calendarInfo.size)
			? calendarInfo
			: worker.addCalendar("").then(() => loadCalendarInfos()))
}

function getParsedEvent(fileData: DataFile): ?{event: CalendarEvent, uid: string} {
	try {
		const {contents} = parseCalendarFile(fileData)
		const parsedEventWithAlarms = contents[0]
		if (parsedEventWithAlarms && parsedEventWithAlarms.event.uid) {
			return {event: parsedEventWithAlarms.event, uid: parsedEventWithAlarms.event.uid}
		} else {
			return null
		}
	} catch (e) {
		console.log(e)
		return null
	}
}

export function showEventDetails(event: CalendarEvent, mail: ?Mail) {
	return Promise.all([
		loadOrCreateCalendarInfo(),
		locator.mailModel.getUserMailboxDetails(),
		event.uid && worker.getEventByUid(event.uid)
	]).then(([calendarInfo, mailboxDetails, dbEvent]) => {
		if (dbEvent) {
			showCalendarEventDialog(dbEvent.startTime, calendarInfo, mailboxDetails, dbEvent, mail)
		} else {
			showCalendarEventDialog(event.startTime, calendarInfo, mailboxDetails, event, mail)
		}
	})
}

export function eventDetailsForFile(file: TutanotaFile): Promise<?CalendarEvent> {
	return worker.downloadFileContent(file).then((fileData) => {
		const parsedEventWithAlarms = getParsedEvent(fileData)
		if (parsedEventWithAlarms == null) {
			return null
		}
		const parsedEvent = parsedEventWithAlarms.event
		return worker.getEventByUid(parsedEventWithAlarms.uid).then((existingEvent) => {
			if (existingEvent) {
				// It should be the latest version eventually via CalendarEventUpdates
				return existingEvent
			} else {
				// Set isCopy here to show that this is not created by us
				parsedEvent.isCopy = true
				return parsedEvent
			}
		})
	})
}

export function replyToEventInvitation(
	event: CalendarEvent,
	attendee: CalendarEventAttendee,
	decision: CalendarAttendeeStatusEnum,
	previousMail: Mail
): Promise<void> {
	const eventClone = clone(event)
	const foundAttendee = assertNotNull(eventClone.attendees.find((a) => a.address.address === attendee.address.address))
	foundAttendee.status = decision
	eventClone.sequence = incrementSequence(eventClone.sequence)
	return locator.mailModel.getMailboxDetailsForMail(previousMail).then(mailboxDetails => {
		const sendMailModel = new SendMailModel(logins, locator.mailModel, locator.contactModel, locator.eventController, mailboxDetails)
		return calendarUpdateDistributor.sendResponse(eventClone, sendMailModel, foundAttendee.address.address, previousMail, decision)
	})
}