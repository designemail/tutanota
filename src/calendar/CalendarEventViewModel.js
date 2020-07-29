//@flow
import type {CalendarInfo} from "./CalendarView"
import type {AlarmIntervalEnum, CalendarAttendeeStatusEnum, EndTypeEnum, RepeatPeriodEnum} from "../api/common/TutanotaConstants"
import {
	AccountType,
	CalendarAttendeeStatus,
	EndType,
	getAttendeeStatus,
	RepeatPeriod,
	ShareCapability,
	TimeFormat
} from "../api/common/TutanotaConstants"
import {createCalendarEventAttendee} from "../api/entities/tutanota/CalendarEventAttendee"
import type {CalendarEvent} from "../api/entities/tutanota/CalendarEvent"
import {createCalendarEvent} from "../api/entities/tutanota/CalendarEvent"
import type {AlarmInfo} from "../api/entities/sys/AlarmInfo"
import {createAlarmInfo} from "../api/entities/sys/AlarmInfo"
import type {MailboxDetail} from "../mail/MailModel"
import stream from "mithril/stream/stream.js"
import {copyMailAddress, getDefaultSenderFromUser, getEnabledMailAddressesWithUser, getSenderNameForUser} from "../mail/MailUtils"
import {
	createRepeatRuleWithValues,
	filterInt,
	generateUid,
	getAllDayDateForTimezone,
	getAllDayDateUTCFromZone,
	getDiffInDays,
	getEventEnd,
	getEventStart, getNextHalfHour,
	getStartOfDayWithZone,
	getStartOfNextDayWithZone,
	getTimeZone,
	hasCapabilityOnGroup,
	incrementSequence,
	parseTime,
	timeString,
	timeStringFromParts,
	timeStringInZone
} from "./CalendarUtils"
import {assertNotNull, clone, downcast, neverNull, noOp} from "../api/common/utils/Utils"
import {generateEventElementId, isAllDayEvent} from "../api/common/utils/CommonCalendarUtils"
import {calendarModel, CalendarModel, incrementByRepeatPeriod} from "./CalendarModel"
import {DateTime} from "luxon"
import type {EncryptedMailAddress} from "../api/entities/tutanota/EncryptedMailAddress"
import {createEncryptedMailAddress} from "../api/entities/tutanota/EncryptedMailAddress"
import {NotFoundError} from "../api/common/error/RestError"
import type {User} from "../api/entities/sys/User"
import {incrementDate} from "../api/common/utils/DateUtils"
import type {CalendarUpdateDistributor} from "./CalendarUpdateDistributor"
import {calendarUpdateDistributor} from "./CalendarUpdateDistributor"
import type {IUserController} from "../api/main/UserController"
import type {RecipientInfo, RecipientInfoTypeEnum} from "../api/common/RecipientInfo"
import {RecipientInfoType} from "../api/common/RecipientInfo"
import type {Contact} from "../api/entities/tutanota/Contact"
import {SendMailModel} from "../mail/SendMailModel"
import {firstThrow, flat} from "../api/common/utils/ArrayUtils"
import {addMapEntry} from "../api/common/utils/MapUtils"
import type {RepeatRule} from "../api/entities/sys/RepeatRule"
import {UserError} from "../api/common/error/UserError"
import type {Mail} from "../api/entities/tutanota/Mail"
import {logins} from "../api/main/LoginController"
import {locator} from "../api/main/MainLocator"

const TIMESTAMP_ZERO_YEAR = 1970

// whether to close dialog
export type EventCreateResult = boolean

const EventType = Object.freeze({
	OWN: "own",
	SHARED_RO: "shared_ro",
	SHARED_RW: "shared_rw",
	INVITE: "invite",
})
type EventTypeEnum = $Values<typeof EventType>

export type Guest = {|
	address: EncryptedMailAddress,
	type: RecipientInfoTypeEnum,
	status: CalendarAttendeeStatusEnum,
	password: ?string,
|}

type SendMailPurpose = "invite" | "update" | "cancel" | "response"
type SendMailModelFactory = (MailboxDetail, SendMailPurpose) => SendMailModel

type RepeatData = {|
	frequency: RepeatPeriodEnum,
	interval: number,
	endType: EndTypeEnum,
	endValue: number
|}

/**
 * ViewModel for viewing/editing the event. Takes care of sending out updates.
 */
export class CalendarEventViewModel {
	+summary: Stream<string>;
	+selectedCalendar: Stream<?CalendarInfo>;
	startDate: Date;
	endDate: Date;
	startTime: string;
	endTime: string;
	+allDay: Stream<boolean>;
	repeat: ?RepeatData
	calendars: Array<CalendarInfo>
	+attendees: Stream<$ReadOnlyArray<Guest>>;
	organizer: ?EncryptedMailAddress;
	+possibleOrganizers: $ReadOnlyArray<EncryptedMailAddress>;
	+location: Stream<string>;
	note: string;
	+amPmFormat: boolean;
	+existingEvent: ?CalendarEvent
	_oldStartTime: ?string;
	+_zone: string;
	// We keep alarms read-only so that view can diff just array and not all elements
	alarms: $ReadOnlyArray<AlarmInfo>;
	_user: User;
	+_eventType: EventTypeEnum;
	+_distributor: CalendarUpdateDistributor;
	+_calendarModel: CalendarModel;
	+_inviteModel: SendMailModel;
	+_updateModel: SendMailModel;
	+_cancelModel: SendMailModel;
	+_mailAddresses: Array<string>;
	// We want to observe changes to it. To not mutate accidentally without stream update we keep it immutable.
	+_guestStatuses: Stream<$ReadOnlyMap<string, CalendarAttendeeStatusEnum>>;
	+_sendModelFactory: () => SendMailModel;
	/** Our own attendee, it should not be included in any of the sendMailModels. */
	+_ownAttendee: Stream<?EncryptedMailAddress>;
	_responseTo: ?Mail
	+sendingOutUpdate: Stream<boolean>
	_processing: boolean;

	constructor(
		userController: IUserController,
		distributor: CalendarUpdateDistributor,
		calendarModel: CalendarModel,
		mailboxDetail: MailboxDetail,
		sendMailModelFactory: SendMailModelFactory,
		date: Date,
		zone: string,
		calendars: Map<Id, CalendarInfo>,
		existingEvent?: ?CalendarEvent,
		responseTo: ?Mail,
		resolveRecipientsLazily: boolean,
	) {
		this._distributor = distributor
		this._calendarModel = calendarModel
		this._responseTo = responseTo
		this._inviteModel = sendMailModelFactory(mailboxDetail, "invite")
		this._updateModel = sendMailModelFactory(mailboxDetail, "update")
		this._cancelModel = sendMailModelFactory(mailboxDetail, "cancel")
		this.summary = stream("")
		this._sendModelFactory = () => sendMailModelFactory(mailboxDetail, "response")
		this._mailAddresses = getEnabledMailAddressesWithUser(mailboxDetail, userController.userGroupInfo)
		this._ownAttendee = stream(null)
		this.sendingOutUpdate = stream(false)
		this._processing = false

		const existingOrganizer = existingEvent && existingEvent.organizer
		this.organizer = existingOrganizer
			? copyMailAddress(existingOrganizer)
			: addressToMailAddress(getDefaultSenderFromUser(userController), mailboxDetail, userController)
		this.location = stream("")
		this.note = ""
		this.allDay = stream(false)
		this.amPmFormat = userController.userSettingsGroupRoot.timeFormat === TimeFormat.TWELVE_HOURS
		this.existingEvent = existingEvent
		this._zone = zone
		this.alarms = []
		this._user = userController.user

		this._guestStatuses = this._initGuestStatus(existingEvent, resolveRecipientsLazily)
		this.attendees = this._initAttendees()
		if (existingEvent) {
			if (existingEvent.invitedConfidentially != null) {
				this.setConfidential(existingEvent.invitedConfidentially)
			}
		}
		this._eventType = this._initEventType(existingEvent, calendars)

		this.possibleOrganizers = existingOrganizer && !this.canModifyOrganizer()
			? [existingOrganizer]
			: existingOrganizer && !this._mailAddresses.includes(existingOrganizer.address)
				? [existingOrganizer].concat(this._ownPossibleOrganizers(mailboxDetail, userController))
				: this._ownPossibleOrganizers(mailboxDetail, userController)

		this.calendars = Array.from(calendars.values())
		this.selectedCalendar = stream(this.getAvailableCalendars()[0])

		if (existingEvent) {
			this._applyValuesFromExistingEvent(existingEvent, calendars)
		} else {
			// We care about passed time here, use it for default time values.
			this._setDefaultTimes(date)
			this.startDate = getStartOfDayWithZone(date, this._zone)
			this.endDate = getStartOfDayWithZone(date, this._zone)
		}

	}

	_applyValuesFromExistingEvent(existingEvent: CalendarEvent, calendars: Map<Id, CalendarInfo>): void {
		this.summary(existingEvent.summary)
		const calendarForGroup = calendars.get(neverNull(existingEvent._ownerGroup))
		if (calendarForGroup) {
			this.selectedCalendar(calendarForGroup)
		}
		this.allDay(isAllDayEvent(existingEvent))
		this.startDate = getStartOfDayWithZone(getEventStart(existingEvent, this._zone), this._zone)
		if (this.allDay()) {
			this.endDate = incrementDate(getEventEnd(existingEvent, this._zone), -1)
			// We don't care about passed time here, just use current one as default
			this._setDefaultTimes()
		} else {
			this.startTime = timeStringInZone(getEventStart(existingEvent, this._zone), this.amPmFormat, this._zone)
			this.endTime = timeStringInZone(getEventEnd(existingEvent, this._zone), this.amPmFormat, this._zone)
			this.endDate = getStartOfDayWithZone(getEventEnd(existingEvent, this._zone), this._zone)
		}

		if (existingEvent.repeatRule) {
			const existingRule = existingEvent.repeatRule
			const repeat = {
				frequency: downcast(existingRule.frequency),
				interval: Number(existingRule.interval),
				endType: downcast(existingRule.endType),
				endValue: existingRule.endType === EndType.Count ? Number(existingRule.endValue) : 1,
			}
			if (existingRule.endType === EndType.UntilDate) {
				const rawEndDate = new Date(Number(existingRule.endValue))
				const localDate = this.allDay() ? getAllDayDateForTimezone(rawEndDate, this._zone) : rawEndDate
				// Shown date is one day behind the actual end (for us it's excluded)
				const shownDate = incrementByRepeatPeriod(localDate, RepeatPeriod.DAILY, -1, this._zone)
				repeat.endValue = shownDate.getTime()
			}
			this.repeat = repeat
		} else {
			this.repeat = null
		}
		this.location(existingEvent.location)
		this.note = existingEvent.description

		this._calendarModel.loadAlarms(existingEvent.alarmInfos, this._user).then((alarms) => {
			alarms.forEach((alarm) => this.addAlarm(downcast(alarm.alarmInfo.trigger)))
		})
	}

	/**
	 * Capability for events is fairly complicated:
	 * Note: share "shared" means "not owner of the calendar". Calendar always looks like personal for the owner.
	 *
	 * | Calendar | edit details    | own attendance | guests | organizer
	 * |----------|-----------------|----------------|--------|----------
	 * | Personal | yes             | yes            | yes    | yes
	 * | Personal | yes (local)     | yes            | no     | no
	 * | Shared   | yes***          | no             | no*    | no*
	 * | Shared   | yes*** (local)  | no**           | no*    | no*
	 *
	 *   * we don't allow sharing in other people's calendar because later only organizer can modify event and
	 *   we don't want to prevent calendar owner from editing events in their own calendar.
	 *
	 *   ** this is not "our" copy of the event, from the point of organizer we saw it just accidentally.
	 *   Later we might support proposing ourselves as attendee but currently organizer should be asked to
	 *   send out the event.
	 *
	 *   *** depends on share capability. Cannot edit if it's not a copy and there are attendees.
	 */
	_initEventType(existingEvent: ?CalendarEvent, calendars: Map<Id, CalendarInfo>): EventTypeEnum {
		if (!existingEvent) {
			return EventType.OWN
		} else {
			// OwnerGroup is not set for events from file
			const calendarInfoForEvent = existingEvent._ownerGroup && calendars.get(existingEvent._ownerGroup)
			if (calendarInfoForEvent) {
				if (calendarInfoForEvent.shared) {
					return hasCapabilityOnGroup(this._user, calendarInfoForEvent.group, ShareCapability.Write)
						? EventType.SHARED_RW
						: EventType.SHARED_RO
				} else {
					return (existingEvent.organizer == null || this._mailAddresses.includes(existingEvent.organizer.address))
						? EventType.OWN
						: EventType.INVITE
				}
			} else {
				// We can edit new invites (from files)
				return EventType.INVITE
			}
		}
	}

	_initGuestStatus(existingEvent: ?CalendarEvent, resolveRecipientsLazily: boolean): Stream<$ReadOnlyMap<string, CalendarAttendeeStatusEnum>> {
		const newStatuses = new Map()
		if (existingEvent) {
			existingEvent.attendees.forEach((attendee) => {
				if (this._mailAddresses.includes(attendee.address.address)) {
					this._ownAttendee(copyMailAddress(attendee.address))
				} else {
					this._updateModel.addRecipient("bcc", {
						name: attendee.address.name,
						address: attendee.address.address,
					}, resolveRecipientsLazily)
				}
				newStatuses.set(attendee.address.address, getAttendeeStatus(attendee))
			})
		}
		return stream(newStatuses)
	}

	_initAttendees(): Stream<Array<Guest>> {
		return stream.merge(
			[this._inviteModel.recipientsChanged, this._updateModel.recipientsChanged, this._guestStatuses, this._ownAttendee]
		).map(() => {
			const guests = this._inviteModel._bccRecipients.concat(this._updateModel._bccRecipients)
			                   .map((recipientInfo) => {
				                   const password =
					                   recipientInfo.contact && recipientInfo.contact.presharedPassword || null
				                   return {
					                   address: createEncryptedMailAddress({
						                   name: recipientInfo.name,
						                   address: recipientInfo.mailAddress,
					                   }),
					                   status: this._guestStatuses().get(recipientInfo.mailAddress)
						                   || CalendarAttendeeStatus.NEEDS_ACTION,
					                   type: recipientInfo.type,
					                   password,
				                   }
			                   })
			const ownAttendee = this._ownAttendee()
			if (ownAttendee) {
				guests.unshift({
					address: ownAttendee,
					status: this._guestStatuses().get(ownAttendee.address) || CalendarAttendeeStatus.ACCEPTED,
					type: RecipientInfoType.INTERNAL,
					password: null,
				})
			}
			return guests
		})
	}

	_setDefaultTimes(date: Date = getNextHalfHour()) {
		const endTimeDate = new Date(date)
		endTimeDate.setMinutes(endTimeDate.getMinutes() + 30)
		this.startTime = timeString(date, this.amPmFormat)
		this.endTime = timeString(endTimeDate, this.amPmFormat)
	}

	_ownPossibleOrganizers(mailboxDetail: MailboxDetail, userController: IUserController): Array<EncryptedMailAddress> {
		return this._mailAddresses.map((address) => addressToMailAddress(address, mailboxDetail, userController))
	}

	findOwnAttendee(): ?Guest {
		return this.attendees().find(a => this._mailAddresses.includes(a.address.address))
	}

	onStartTimeSelected(value: string) {
		this._oldStartTime = this.startTime
		this.startTime = value
		if (this.startDate.getTime() === this.endDate.getTime()) {
			this._adjustEndTime()
		}
	}

	onEndTimeSelected(value: string) {
		this.endTime = value
	}

	addAttendee(mailAddress: string, contact: ?Contact) {
		if (this.attendees().find((a) => a.address.address === mailAddress)) {
			return
		}
		const recipientInfo = this._inviteModel.addRecipient("bcc", {address: mailAddress, contact, name: null})
		const isOwnAttendee = this._mailAddresses.includes(mailAddress)
		const status = isOwnAttendee ? CalendarAttendeeStatus.ACCEPTED : CalendarAttendeeStatus.ADDED
		this._guestStatuses(addMapEntry(this._guestStatuses(), recipientInfo.mailAddress, status))

		if (this.attendees().length === 1 && this.findOwnAttendee() == null) {
			this.selectGoing(CalendarAttendeeStatus.ACCEPTED)
		}
	}

	isReadOnlyEvent(): boolean {
		return this._eventType === EventType.SHARED_RO
			|| this._eventType === EventType.SHARED_RW && this.attendees().length > 0
	}

	_adjustEndTime() {
		const parsedOldStartTime = this._oldStartTime && parseTime(this._oldStartTime)
		const parsedStartTime = parseTime(this.startTime)
		const parsedEndTime = parseTime(this.endTime)
		if (!parsedStartTime || !parsedEndTime || !parsedOldStartTime) {
			return
		}
		const endTotalMinutes = parsedEndTime.hours * 60 + parsedEndTime.minutes
		const startTotalMinutes = parsedStartTime.hours * 60 + parsedStartTime.minutes
		const diff = Math.abs(endTotalMinutes - parsedOldStartTime.hours * 60 - parsedOldStartTime.minutes)
		const newEndTotalMinutes = startTotalMinutes + diff
		let newEndHours = Math.floor(newEndTotalMinutes / 60)
		if (newEndHours > 23) {
			newEndHours = 23
		}
		const newEndMinutes = newEndTotalMinutes % 60
		this.endTime = timeStringFromParts(newEndHours, newEndMinutes, this.amPmFormat)
	}

	onStartDateSelected(date: ?Date) {
		if (date) {
			// The custom ID for events is derived from the unix timestamp, and sorting the negative ids is a challenge we decided not to
			// tackle because it is a rare case.
			if (date && date.getFullYear() < TIMESTAMP_ZERO_YEAR) {
				const thisYear = (new Date()).getFullYear()
				let newDate = new Date(date)
				newDate.setFullYear(thisYear)
				this.startDate = newDate
			} else {
				const diff = getDiffInDays(date, this.startDate)
				this.endDate = DateTime.fromJSDate(this.endDate, {zone: this._zone}).plus({days: diff}).toJSDate()
				this.startDate = date
			}
		}
	}

	onEndDateSelected(date: ?Date) {
		if (date) {
			this.endDate = date
		}
	}

	onRepeatPeriodSelected(repeatPeriod: ?RepeatPeriodEnum) {
		if (repeatPeriod == null) {
			this.repeat = null
		} else {
			// Provide default values if repeat is not there, override them with existing repeat if it's there, provide new frequency
			// First empty object is for Flow.
			this.repeat = Object.assign(
				{interval: 1, endType: EndType.Never, endValue: 1, frequency: repeatPeriod},
				this.repeat,
				{frequency: repeatPeriod}
			)
		}
	}

	onEndOccurencesSelected(endValue: number) {
		if (this.repeat && this.repeat.endType === EndType.Count) {
			this.repeat.endValue = endValue
		}
	}

	onRepeatEndDateSelected(endDate: ?Date) {
		const {repeat} = this
		if (endDate && repeat && repeat.endType === EndType.UntilDate) {
			repeat.endValue = endDate.getTime()
		}
	}

	onRepeatIntervalChanged(interval: number) {
		if (this.repeat) {
			this.repeat.interval = interval
		}
	}

	onRepeatEndTypeChanged(endType: EndTypeEnum) {
		const {repeat} = this
		if (repeat) {
			repeat.endType = endType
			if (endType === EndType.UntilDate) {
				repeat.endValue = incrementByRepeatPeriod(new Date(), RepeatPeriod.MONTHLY, 1, this._zone).getTime()
			} else {
				repeat.endValue = 1
			}
		}
	}

	addAlarm(trigger: AlarmIntervalEnum) {
		const alarm = createCalendarAlarm(generateEventElementId(Date.now()), trigger)
		this.alarms = this.alarms.concat(alarm)
	}

	changeAlarm(identifier: string, trigger: ?AlarmIntervalEnum) {
		const newAlarms = this.alarms.slice()
		for (let i = 0; i < newAlarms.length; i++) {
			if (newAlarms[i].alarmIdentifier === identifier) {
				if (trigger) {
					newAlarms[i].trigger = trigger
				} else {
					newAlarms.splice(i, 1)
				}
				this.alarms = newAlarms
				break
			}
		}
	}

	changeDescription(description: string) {
		this.note = description
	}

	canModifyGuests(): boolean {
		// It is not allowed to modify guests in shared calendar or invite.
		const selectedCalendar = this.selectedCalendar()
		return selectedCalendar != null && !selectedCalendar.shared && this._eventType !== EventType.INVITE
	}

	removeAttendee(guest: Guest) {
		const existingRecipient = this.existingEvent
			&& this.existingEvent.attendees.find((a) => a.address.address === guest.address.address)
		for (const model of [this._inviteModel, this._updateModel, this._cancelModel]) {
			const recipientInfo = model._bccRecipients.find(r => r.mailAddress === guest.address.address)
			if (recipientInfo) {
				model.removeRecipient("bcc", recipientInfo)

				const newStatuses = new Map(this._guestStatuses())
				newStatuses.delete(recipientInfo.mailAddress)
				this._guestStatuses(newStatuses)
			}
		}
		if (existingRecipient) {
			this._cancelModel.addRecipient("bcc", {
				address: existingRecipient.address.address,
				name: existingRecipient.address.name,
				contact: null,
			})
		}
	}

	canModifyOwnAttendance(): boolean {
		return (this._eventType === EventType.OWN || this._eventType === EventType.INVITE)
			&& (this._viewingOwnEvent() || !!this.findOwnAttendee())
	}

	canModifyOrganizer(): boolean {
		return this._eventType === EventType.OWN
			&& (!this.existingEvent
				|| (this.existingEvent.attendees.length === 0)
				|| (this.existingEvent.attendees.length === 1
					&& this._mailAddresses.includes(this.existingEvent.attendees[0].address.address)))
	}

	setOrganizer(newOrganizer: EncryptedMailAddress): void {
		if (this.canModifyOrganizer()) {
			this.organizer = newOrganizer
			this._ownAttendee(newOrganizer)
		}
	}

	canModifyAlarms(): boolean {
		return this._eventType === EventType.OWN
			|| this._eventType === EventType.INVITE
			|| this._eventType === EventType.SHARED_RW
	}

	_viewingOwnEvent(): boolean {
		// it is our own event if it is a new event, existing event without organizer or we are organizer
		return this._eventType === EventType.OWN
	}

	deleteEvent(): Promise<void> {
		const event = this.existingEvent
		if (event) {
			const awaitCancellation = this._eventType === EventType.OWN && event.attendees.length
				? this._sendCancellation(event)
				: Promise.resolve()
			return awaitCancellation.then(() => this._calendarModel.deleteEvent(event)).catch(NotFoundError, noOp)
		} else {
			return Promise.resolve()
		}
	}

	_sendCancellation(event: CalendarEvent): Promise<*> {
		const updatedEvent = clone(event)
		updatedEvent.sequence = incrementSequence(updatedEvent.sequence)
		const cancelAddresses = event.attendees
		                             .filter(a => !this._mailAddresses.includes(a.address.address))
		                             .map(a => a.address)
		cancelAddresses.forEach((a) => {
			this._cancelModel.addRecipient("bcc", {name: a.name, address: a.address, contact: null})
		})
		return this._distributor.sendCancellation(updatedEvent, this._cancelModel)
	}

	_checkPasswords(): void {
		const needsPassword = this.attendees().some((a) => a.type === RecipientInfoType.EXTERNAL
			&& (a.password == null || a.password === ""))
		if (needsPassword) {
			throw new UserError("noPreSharedPassword_msg")
		}
	}

	/**
	 * @reject UserError
	 */
	saveAndSend(
		{askForUpdates, askInsecurePassword, showProgress}: {
			askForUpdates: () => Promise<boolean>,
			askInsecurePassword: () => Promise<boolean>,
			showProgress: (Promise<mixed> => mixed),
		}
	): Promise<EventCreateResult> {
		if (this._processing) {
			return Promise.resolve(false)
		}
		const selectedCalendar = this.selectedCalendar()
		this._processing = true
		return Promise.resolve().then(() => {
			// We have to use existing instance to get all the final fields correctly
			// Using clone feels hacky but otherwise we need to save all attributes of the existing event somewhere and if dialog is
			// cancelled we also don't want to modify passed event
			const newEvent = this.existingEvent ? clone(this.existingEvent) : createCalendarEvent()

			let startDate = new Date(this.startDate)
			let endDate = new Date(this.endDate)

			if (this.allDay()) {
				startDate = getAllDayDateUTCFromZone(startDate, this._zone)
				endDate = getAllDayDateUTCFromZone(getStartOfNextDayWithZone(endDate, this._zone), this._zone)
			} else {
				const parsedStartTime = parseTime(this.startTime)
				const parsedEndTime = parseTime(this.endTime)
				if (!parsedStartTime || !parsedEndTime) {
					throw new UserError("timeFormatInvalid_msg")
				}
				startDate = DateTime.fromJSDate(startDate, {zone: this._zone})
				                    .set({hour: parsedStartTime.hours, minute: parsedStartTime.minutes})
				                    .toJSDate()

				// End date is never actually included in the event. For the whole day event the next day
				// is the boundary. For the timed one the end time is the boundary.
				endDate = DateTime.fromJSDate(endDate, {zone: this._zone})
				                  .set({hour: parsedEndTime.hours, minute: parsedEndTime.minutes})
				                  .toJSDate()
			}

			if (endDate.getTime() <= startDate.getTime()) {
				throw new UserError("startAfterEnd_label")
			}
			newEvent.startTime = startDate
			newEvent.description = this.note
			newEvent.summary = this.summary()
			newEvent.location = this.location()
			newEvent.endTime = endDate
			newEvent.invitedConfidentially = this.isConfidential()
			newEvent.uid = this.existingEvent && this.existingEvent.uid
				? this.existingEvent.uid
				: generateUid(assertNotNull(selectedCalendar).group._id, Date.now())
			const repeat = this.repeat
			if (repeat == null) {
				newEvent.repeatRule = null
			} else {
				newEvent.repeatRule = this.createRepeatRule(newEvent, repeat)
			}
			const newAlarms = this.alarms.slice()
			newEvent.attendees = this.attendees().map((a) => createCalendarEventAttendee({
				address: a.address,
				status: a.status,
			}))
			if (this.existingEvent) {
				newEvent.sequence = String(filterInt(this.existingEvent.sequence) + 1)
			}

			// We need to compute diff of attendees to know if we need to send out updates
			let existingAttendees: Array<Guest> = []
			const {existingEvent} = this
			newEvent.organizer = this.organizer

			if (this._viewingOwnEvent()) {
				// if it is our own event we need to collect email addresses of attendees to send update notification.
				if (existingEvent) {
					this.attendees().forEach((guest) => {
						if (this._mailAddresses.includes(guest.address.address)) {
							return
						}
						if (existingEvent.attendees.find(ea => ea.address.address === guest.address.address)) {
							existingAttendees.push(guest)
						}
					})
				}
			} else {
				if (existingEvent) {
					// We are not using this._findAttendee() because we want to search it on the event, before our modifications
					const ownAttendee = existingEvent.attendees.find(a => this._mailAddresses.includes(a.address.address))
					const going = ownAttendee && this._guestStatuses().get(ownAttendee.address.address)
					if (ownAttendee && going !== CalendarAttendeeStatus.NEEDS_ACTION && ownAttendee.status !== going) {
						ownAttendee.status = assertNotNull(going)
						const sendResponseModel = this._sendModelFactory()
						const organizer = assertNotNull(existingEvent.organizer)
						sendResponseModel.addRecipient("to", {name: organizer.name, address: organizer.address, contact: null})
						this._distributor.sendResponse(newEvent, sendResponseModel, ownAttendee.address.address, this._responseTo,
							assertNotNull(going)
						).then(() => sendResponseModel.dispose())
					}
				}
			}

			const doCreateEvent = () => {
				if (this._user.accountType === AccountType.EXTERNAL) {
					return Promise.resolve()
				}
				const groupRoot = assertNotNull(this.selectedCalendar()).groupRoot
				if (existingEvent == null || existingEvent._id == null) {
					return this._calendarModel.createEvent(newEvent, newAlarms, this._zone, groupRoot)
				} else {
					return this._calendarModel.updateEvent(newEvent, newAlarms, this._zone, groupRoot, existingEvent)
				}
			}

			const passwordCheck = () => this.hasInsecurePasswords().then((hasInsecure) => hasInsecure ? askInsecurePassword() : true)
			if (this._viewingOwnEvent()) {
				if (existingAttendees.length || this._cancelModel._bccRecipients.length) {
					// ask for update
					return askForUpdates().then((sendOutUpdate) => {
						return Promise.resolve(sendOutUpdate ? passwordCheck() : true)
						              .then((send) => {
							              if (!send) return false

							              const p = this._sendInvite(newEvent)
							                            .then(() => this._cancelModel._bccRecipients.length
								                            ? this._distributor.sendCancellation(newEvent, this._cancelModel)
								                            : Promise.resolve())
							                            .then(() => doCreateEvent())
							                            .then(() => {
								                            if (sendOutUpdate && existingAttendees.length) {
									                            return this._distributor.sendUpdate(newEvent, this._updateModel)
								                            }
							                            })
							                            .then(() => true)
							              showProgress(p)
							              return p
						              })
					})
				} else {
					// just create the event if there are no existing recipients
					return passwordCheck().then((send) => {
						if (!send) return false
						const p = this._sendInvite(newEvent)
						              .then(() => doCreateEvent())
						              .then(() => true)
						showProgress(p)
						return p
					})
				}
			} else {
				return passwordCheck()
					.then((send) => {
						if (send) {
							const p = doCreateEvent()
							showProgress(p)
							return p
						}
					})
					.then(() => true)
			}
		}).finally(() => {
			console.log("finished saving", this._processing)
			this._processing = false
		})
	}

	selectGoing(going: CalendarAttendeeStatusEnum) {
		if (this.canModifyOwnAttendance()) {
			const ownAttendee = this._ownAttendee()
			if (ownAttendee) {
				this._guestStatuses(addMapEntry(this._guestStatuses(), ownAttendee.address, going))
			} else if (this._eventType === EventType.OWN) {
				const newOwnAttendee = createEncryptedMailAddress({address: firstThrow(this._mailAddresses)})
				this._ownAttendee(newOwnAttendee)
				this._guestStatuses(addMapEntry(this._guestStatuses(), newOwnAttendee.address, going))
			}
		}
	}


	_sendInvite(event: CalendarEvent): Promise<void> {
		const newAttendees = event.attendees.filter((a) => a.status === CalendarAttendeeStatus.ADDED)
		if (newAttendees.length > 0) {
			return this._distributor.sendInvite(event, this._inviteModel)
			           .then(() => {
				           newAttendees.forEach((a) => {
					           if (a.status === CalendarAttendeeStatus.ADDED) {
						           a.status = CalendarAttendeeStatus.NEEDS_ACTION
					           }
					           this._guestStatuses(addMapEntry(this._guestStatuses(), a.address.address, CalendarAttendeeStatus.NEEDS_ACTION))
				           })
			           })
		} else {
			return Promise.resolve()
		}
	}

	createRepeatRule(newEvent: CalendarEvent, repeat: RepeatData): RepeatRule {
		const interval = repeat.interval || 1
		const repeatRule = createRepeatRuleWithValues(repeat.frequency, interval)
		const stopType = repeat.endType
		repeatRule.endType = stopType
		if (stopType === EndType.Count) {
			const count = repeat.endValue
			if (isNaN(count) || Number(count) < 1) {
				repeatRule.endType = EndType.Never
			} else {
				repeatRule.endValue = String(count)
			}
		} else if (stopType === EndType.UntilDate) {
			const repeatEndDate = getStartOfNextDayWithZone(new Date(repeat.endValue), this._zone)
			if (repeatEndDate.getTime() < getEventStart(newEvent, this._zone)) {
				throw new UserError("startAfterEnd_label")
			} else {
				// We have to save repeatEndDate in the same way we save start/end times because if one is timzone
				// dependent and one is not then we have interesting bugs in edge cases (event created in -11 could
				// end on another date in +12). So for all day events end date is UTC-encoded all day event and for
				// regular events it is just a timestamp.
				repeatRule.endValue =
					String((this.allDay() ? getAllDayDateUTCFromZone(repeatEndDate, this._zone) : repeatEndDate).getTime())
			}
		}
		return repeatRule
	}

	setConfidential(confidential: boolean): void {
		this._inviteModel.setConfidential(confidential)
		this._updateModel.setConfidential(confidential)
		this._cancelModel.setConfidential(confidential)
	}

	isConfidential(): boolean {
		return this._inviteModel.isConfidential() && this._updateModel.isConfidential() && this._cancelModel.isConfidential()
	}


	updatePassword(guest: Guest, password: string) {
		const inInite = this._inviteModel._bccRecipients.find((r) => r.mailAddress === guest.address.address)
		if (inInite) {
			this._inviteModel.setPassword(inInite, password)
		}
		const inUpdate = this._updateModel._bccRecipients.find((r) => r.mailAddress === guest.address.address)
		if (inUpdate) {
			this._updateModel.setPassword(inUpdate, password)
		}
		const inCancel = this._cancelModel._bccRecipients.find((r) => r.mailAddress === guest.address.address)
		if (inCancel) {
			this._updateModel.setPassword(inCancel, password)
		}
	}

	shouldShowPasswordFields(): boolean {
		return this.isConfidential() && this._eventType === EventType.OWN
	}

	getPasswordStrength(guest: Guest): number {
		const recipient = this._allRecipients().find((r) => r.mailAddress === guest.address.address)
		return recipient && recipient.contact ? this._inviteModel.getPasswordStrength(assertNotNull(recipient)) : 0
	}

	hasInsecurePasswords(): Promise<boolean> {
		return Promise.resolve().then(() => {
			if (!this.isConfidential()) {
				return Promise.resolve(false)
			}
			if (this._eventType === EventType.INVITE) { // We can't receive invites from external users
				return Promise.resolve(false)
			}
			return Promise.all([
				this._inviteModel._waitForResolvedRecipients(),
				this._updateModel._waitForResolvedRecipients(),
				this._cancelModel._waitForResolvedRecipients()
			]).then((recipientGroups) => {
				const allRecipients = flat(recipientGroups)
				return this.isConfidential() && allRecipients
					.filter(recipient => recipient.contact && recipient.contact.presharedPassword)
					.some(recipient => this._inviteModel.getPasswordStrength(recipient) < 80)
			})
		})
	}

	getAvailableCalendars(): Array<CalendarInfo> {
		// Prevent moving the calendar to another calendar if you only have read permission or if the event has attendees.
		if (this.isReadOnlyEvent()) {
			return this.calendars
			           .filter((calendarInfo) => calendarInfo.group._id === assertNotNull(this.existingEvent)._ownerGroup)
		} else if (this.attendees().length && this._eventType !== EventType.INVITE) {
			// We don't allow inviting in a shared calendar. If we have attendees, we cannot select a shared calendar
			return this.calendars
			           .filter((calendarInfo) => !calendarInfo.shared)
		} else {
			return this.calendars
			           .filter((calendarInfo) => hasCapabilityOnGroup(this._user, calendarInfo.group, ShareCapability.Write))
		}
	}

	_allRecipients(): Array<RecipientInfo> {
		return this._inviteModel._allRecipients().concat(this._updateModel._allRecipients()).concat(this._cancelModel._allRecipients())
	}

	dispose(): void {
		this._inviteModel.dispose()
		this._updateModel.dispose()
		this._cancelModel.dispose()
	}

	isInvite(): boolean {
		return this._eventType === EventType.INVITE
	}
}

function addressToMailAddress(address: string, mailboxDetail: MailboxDetail, userController: IUserController): EncryptedMailAddress {
	return createEncryptedMailAddress({
		address,
		name: getSenderNameForUser(mailboxDetail, userController)
	})
}

function createCalendarAlarm(identifier: string, trigger: string): AlarmInfo {
	const calendarAlarmInfo = createAlarmInfo()
	calendarAlarmInfo.alarmIdentifier = identifier
	calendarAlarmInfo.trigger = trigger
	return calendarAlarmInfo
}


export function createCalendarEventViewModel(date: Date, calendars: Map<Id, CalendarInfo>, mailboxDetail: MailboxDetail,
                                             existingEvent: ?CalendarEvent, previousMail: ?Mail, resolveRecipientsLazily: boolean,
): CalendarEventViewModel {
	return new CalendarEventViewModel(
		logins.getUserController(),
		calendarUpdateDistributor,
		calendarModel,
		mailboxDetail,
		(mailboxDetail) => new SendMailModel(logins, locator.mailModel, locator.contactModel, locator.eventController, mailboxDetail),
		date,
		getTimeZone(),
		calendars,
		existingEvent,
		previousMail,
		resolveRecipientsLazily,
	)
}