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

function getOrCreatePrivateCalendar(): Promise<?CalendarInfo> {
	if (!logins.isInternalUserLoggedIn()) {
		return Promise.resolve(null)
	} else {
		return loadCalendarInfos()
			.then((calendarInfo) => {
				// addCalendar() has special hack to update memberships immediately so it's safe to load it right away.
				// Otherwise membership might now have been there yet.
				return findPrivateCalendar(calendarInfo) || worker.addCalendar("")
				                                                  .then(() => loadCalendarInfos())
				                                                  .then(findPrivateCalendar)
			})
	}
}

function findPrivateCalendar(calendarInfo: Map<Id, CalendarInfo>): ?CalendarInfo {
	for (const calendar of calendarInfo.values()) {
		if (!calendar.shared) {
			return calendar
		}
	}
	return null
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
		getLatestEvent(event)
	]).then(([calendarInfo, mailboxDetails, latestEvent]) => {
		showCalendarEventDialog(latestEvent.startTime, calendarInfo, mailboxDetails, latestEvent, mail)
	})
}

export function getEventFromFile(file: TutanotaFile): Promise<?CalendarEvent> {
	return worker.downloadFileContent(file).then((fileData) => {
		const parsedEvent = getParsedEvent(fileData)
		return parsedEvent && parsedEvent.event
	})
}

export function getLatestEvent(event: CalendarEvent): Promise<CalendarEvent> {

	const uid = event.uid
	if (uid) {
		return worker.getEventByUid(uid).then((existingEvent) => {
			if (existingEvent) {
				// It should be the latest version eventually via CalendarEventUpdates
				return existingEvent
			} else {
				return event
			}
		})
	} else {
		return Promise.resolve(event)
	}
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
		getOrCreatePrivateCalendar(),
		locator.mailModel.getMailboxDetailsForMail(previousMail)
	]).then(([calendar, mailboxDetails]) => {
		const sendMailModel = new SendMailModel(logins, locator.mailModel, locator.contactModel, locator.eventController, mailboxDetails)
		return calendarUpdateDistributor
			.sendResponse(eventClone, sendMailModel, foundAttendee.address.address, previousMail, decision)
			.catch(UserError, (e) => Dialog.error(() => e.message))
			.then(() => {
				if (calendar) {
					if (event._ownerGroup) {
						return calendarModel.loadAlarms(event.alarmInfos, logins.getUserController().user)
						                    .then((alarms) => {
								                    const alarmInfos = alarms.map((a) => a.alarmInfo)
								                    return calendarModel.updateEvent(eventClone, alarmInfos, getTimeZone(), calendar.groupRoot, event)
							                    }
						                    )
					} else {
						return calendarModel.createEvent(eventClone, [], getTimeZone(), calendar.groupRoot)
					}
				} else {
					return Promise.resolve()
				}
			})
	})
}