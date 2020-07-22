// @flow

import {create, TypeRef} from "../../common/EntityFunctions"


export const CalendarEventUpdateListTypeRef: TypeRef<CalendarEventUpdateList> = new TypeRef("tutanota", "CalendarEventUpdateList")
export const _TypeModel: TypeModel = {
	"name": "CalendarEventUpdateList",
	"since": 42,
	"type": "AGGREGATED_TYPE",
	"id": 1114,
	"rootId": "CHR1dGFub3RhAARa",
	"versioned": false,
	"encrypted": false,
	"values": {
		"_id": {
			"name": "_id",
			"id": 1115,
			"since": 42,
			"type": "CustomId",
			"cardinality": "One",
			"final": true,
			"encrypted": false
		}
	},
	"associations": {
		"list": {
			"name": "list",
			"id": 1116,
			"since": 42,
			"type": "LIST_ASSOCIATION",
			"cardinality": "One",
			"refType": "CalendarEventUpdate",
			"final": true,
			"external": false
		}
	},
	"app": "tutanota",
	"version": "42"
}

export function createCalendarEventUpdateList(values?: $Shape<$Exact<CalendarEventUpdateList>>): CalendarEventUpdateList {
	return Object.assign(create(_TypeModel, CalendarEventUpdateListTypeRef), values)
}

export type CalendarEventUpdateList = {
	_type: TypeRef<CalendarEventUpdateList>;

	_id: Id;

	list: Id;
}