//@flow

import stream from "mithril/stream/stream.js"
import {logins} from "../../api/main/LoginController"
import type {CustomerInfo} from "../../api/entities/sys/CustomerInfo"
import type {DnsRecord} from "../../api/entities/sys/DnsRecord"
import {createDnsRecord} from "../../api/entities/sys/DnsRecord"
import {DnsRecordType, DnsRecordTypeToName} from "../../api/common/TutanotaConstants"
import m from "mithril"
import {ColumnWidth, TableN} from "../../gui/base/TableN"
import {createWizardDialog} from "../../gui/base/WizardDialogN"
import type {EditAliasesFormAttrs} from "../EditAliasesFormN"
import {createEditAliasFormAttrs} from "../EditAliasesFormN"
import {SelectMailAddressForm} from "../SelectMailAddressForm"
import {AddEmailAddressesPage, AddEmailAddressesPageAttrs} from "./AddEmailAddressesPage"
import {DomainDnsStatus} from "../DomainDnsStatus"
import {VerifyOwnershipPage, VerifyOwnershipPageAttrs} from "./VerifyOwnershipPage"
import {VerifyDnsRecordsPage, VerifyDnsRecordsPageAttrs} from "./VerifyDnsRecordsPage"
import {EnterDomainPage, EnterDomainPageAttrs} from "./EnterDomainPage"
import {assertMainOrNode} from "../../api/Env"

assertMainOrNode()

export type AddDomainData = {
	domain: Stream<string>,
	customerInfo: CustomerInfo,
	expectedVerificationRecord: DnsRecord,
	editAliasFormAttrs: EditAliasesFormAttrs,
	emailAliasInput: SelectMailAddressForm,
	domainStatus: DomainDnsStatus
}


export function showAddDomainWizard(domain: string, customerInfo: CustomerInfo): void {
	const domainData: AddDomainData = {
		domain: stream(domain),
		customerInfo: customerInfo,
		expectedVerificationRecord: createDnsRecord(),
		editAliasFormAttrs: createEditAliasFormAttrs(logins.getUserController().userGroupInfo),
		emailAliasInput: new SelectMailAddressForm([domain]),
		domainStatus: new DomainDnsStatus(domain)
	}
	domainData.expectedVerificationRecord.type = DnsRecordType.DNS_RECORD_TYPE_TXT_SPF // not actually spf, but the type TXT only matters here
	domainData.expectedVerificationRecord.subdomain = null
	domainData.expectedVerificationRecord.value = "" // will be filled oncreate by the page

	const wizardPages = [
		{
			attrs: new EnterDomainPageAttrs(domainData),
			componentClass: EnterDomainPage
		},
		{
			attrs: new VerifyOwnershipPageAttrs(domainData),
			componentClass: VerifyOwnershipPage
		},
		{
			attrs: new AddEmailAddressesPageAttrs(domainData),
			componentClass: AddEmailAddressesPage
		},
		{
			attrs: new VerifyDnsRecordsPageAttrs(domainData),
			componentClass: VerifyDnsRecordsPage
		},
	]

	const wizardBuilder = createWizardDialog(domainData, wizardPages)
	const wizard = wizardBuilder.dialog
	const wizardAttrs = wizardBuilder.attrs

	wizard.show()
	// we can skip the next two pages because we assume that the domain is already assigned if it was passed to the wizard
	if (domain.length) {
		wizardAttrs.goToNextPageOrCloseWizard()
		wizardAttrs.goToNextPageOrCloseWizard()
		if (wizardAttrs.currentPage) {
			// skip add email address page if an email address has been assigned
			wizardAttrs.currentPage.attrs.nextAction(false)
			           .then(ready => {
				           if (ready) wizardAttrs.goToNextPageOrCloseWizard()
			           })
		}
	}
}

export type ValidatedDnSRecord =
	{
		record: DnsRecord,
		helpInfo: string[]
	}

export function createDnsRecordTableN(records: ValidatedDnSRecord[]) {

	return m(TableN, {
		columnHeading: [
			"type_label", "dnsRecordHostOrName_label",
			"dnsRecordValueOrPointsTo_label"
		],
		columnWidths: [ColumnWidth.Small, ColumnWidth.Small, ColumnWidth.Largest],
		showActionButtonColumn: false,
		lines: records.map(r => {
			return {
				cells: () => [
					{
						main: DnsRecordTypeToName[r.record.type],
					},
					{
						main: (r.record.subdomain ? r.record.subdomain : "@"),
					},
					{
						main: r.record.value,
						info: r.helpInfo
					}
				]
			}
		})
	})
}

export function createDnsRecordTable(records: DnsRecord[]) {
	return m(TableN, {
		columnHeading: ["type_label", "dnsRecordHostOrName_label", "dnsRecordValueOrPointsTo_label"],
		columnWidths: [ColumnWidth.Small, ColumnWidth.Small, ColumnWidth.Largest],
		showActionButtonColumn: false,
		lines: records.map(r => ({cells: [DnsRecordTypeToName[r.type], (r.subdomain ? r.subdomain : "@"), r.value]}))
	})
}

