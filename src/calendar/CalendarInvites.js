//@flow
import {parseCalendarFile} from "./CalendarImporter"
import {worker} from "../api/main/WorkerClient"
import {showCalendarEventDialog} from "./CalendarEventEditDialog"
import type {CalendarEvent} from "../api/entities/tutanota/CalendarEvent"
import type {File as TutanotaFile} from "../api/entities/tutanota/File"
import {calendarModel, loadCalendarInfos} from "./CalendarModel"
import {locator} from "../api/main/MainLocator"
import type {CalendarEventAttendee} from "../api/entities/tutanota/CalendarEventAttendee"
import type {CalendarAttendeeStatusEnum, CalendarMethodEnum} from "../api/common/TutanotaConstants"
import {CalendarMethod, getAsEnumValue} from "../api/common/TutanotaConstants"
import {assertNotNull, clone} from "../api/common/utils/Utils"
import {getTimeZone, incrementSequence} from "./CalendarUtils"
import type {CalendarInfo} from "./CalendarView"
import {logins} from "../api/main/LoginController"
import {SendMailModel} from "../mail/SendMailModel"
import type {Mail} from "../api/entities/tutanota/Mail"
import {calendarUpdateDistributor} from "./CalendarUpdateDistributor"
import {Dialog} from "../gui/base/Dialog"
import {UserError} from "../api/common/error/UserError"
import {firstThrow} from "../api/common/utils/ArrayUtils"

function loadOrCreateCalendarInfo(): Promise<Map<Id, CalendarInfo>> {
	return loadCalendarInfos()
		.then((calendarInfo) => (!logins.isInternalUserLoggedIn() || calendarInfo.size)
			? calendarInfo
			: worker.addCalendar("").then(() => loadCalendarInfos()))
}

function getParsedEvent(fileData: DataFile): ?{method: CalendarMethodEnum, event: CalendarEvent, uid: string} {
	try {
		const {contents, method} = parseCalendarFile(fileData)
		const verifiedMethod = getAsEnumValue(CalendarMethod, method) || CalendarMethod.PUBLISH
		const parsedEventWithAlarms = contents[0]
		if (parsedEventWithAlarms && parsedEventWithAlarms.event.uid) {
			return {event: parsedEventWithAlarms.event, uid: parsedEventWithAlarms.event.uid, method: verifiedMethod}
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

export function eventDetailsForFile(file: TutanotaFile): Promise<?{event: CalendarEvent, method: CalendarMethodEnum}> {
	return worker.downloadFileContent(file).then((fileData) => {
		const parsedEventWithAlarms = getParsedEvent(fileData)
		return parsedEventWithAlarms

		// return worker.getEventByUid(parsedEventWithAlarms.uid).then((existingEvent) => {
		// 	if (existingEvent) {
		// 		// It should be the latest version eventually via CalendarEventUpdates
		// 		return {event: existingEvent, method}
		// 	} else {
		// 		// Set isCopy here to show that this is not created by us
		// 		parsedEvent.isCopy = true
		// 		return {event: parsedEvent, method}
		// 	}
		// })
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

	return Promise.all([
		loadOrCreateCalendarInfo(),
		locator.mailModel.getMailboxDetailsForMail(previousMail)
	]).then(([calendars, mailboxDetails]) => {
		const calendar = firstThrow(Array.from(calendars.values()))
		const sendMailModel = new SendMailModel(logins, locator.mailModel, locator.contactModel, locator.eventController, mailboxDetails)
		return calendarUpdateDistributor.sendResponse(eventClone, sendMailModel, foundAttendee.address.address, previousMail, decision)
		                                .catch(UserError, (e) => Dialog.error(() => e.message))
		                                .then(() => calendarModel.createEvent(eventClone, [], getTimeZone(), calendar.groupRoot))
	})
}