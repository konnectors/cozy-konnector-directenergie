import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
import pRetry from 'p-retry'

const log = Minilog('ContentScript')
Minilog.enable('totalenergiesCCC')

const baseUrl = 'https://www.totalenergies.fr/'
const MAINTENANCE_URL = 'https://maintenance.direct-energie.com'
const HOMEPAGE_URL =
  'https://www.totalenergies.fr/clients/accueil#fz-authentificationForm'
const contractSelectionPage =
  'https://www.totalenergies.fr/clients/selection-compte'
const contactInfosPage =
  'https://www.totalenergies.fr/clients/mon-compte/mes-infos-de-contact'
// Keeping this urls around in case they're needed in the future
// const billsPage = 'https://www.totalenergies.fr/clients/mes-factures'
// const billsHistoricPage =
//   'https://www.totalenergies.fr/clients/mes-factures/mon-historique-de-factures'

let numberOfContracts = 1

class TemplateContentScript extends ContentScript {
  onWorkerReady() {
    if (document.readyState !== 'loading') {
      this.log('info', 'readyState')
      this.watchLoadingErrors.bind(this)()
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        this.log('info', 'DOMLoaded')
        this.watchLoadingErrors.bind(this)()
      })
    }
  }

  onWorkerEvent({ event, payload }) {
    this.log('info', 'onWorkerEvent starts')
    if (event === 'errorDetected') {
      this.log('info', `Error ${payload} found, sending error to store`)
      this.store.foundError = { event, payload }
    }
  }

  watchLoadingErrors() {
    this.log('info', '📍️ watchLoadingErrors starts')
    const currentBody = document.body
    const isError503 = currentBody?.innerHTML.match(
      'Error 503 - Service Unavailable'
    )
    const isError404 = currentBody?.innerHTML.match(
      "404 - Oups ! Cette page n'existe pas."
    )
    const isErrorProxy = currentBody?.innerHTML.match('Proxy Error')
    if (isError503) {
      this.log('info', 'Found error 503')
      const event = 'errorDetected'
      const payload = '503'
      this.store.foundError = { event, payload }
      this.bridge.emit('workerEvent', {
        event,
        payload
      })
    } else if (isErrorProxy) {
      this.log('info', 'Found a proxy error')
      const event = 'errorDetected'
      const payload = 'proxy'
      this.store.foundError = { event, payload }
      this.bridge.emit('workerEvent', {
        event,
        payload
      })
    } else if (isError404) {
      this.log('info', 'Found error 404')
      const event = 'errorDetected'
      const payload = '404'
      this.bridge.emit('workerEvent', {
        event,
        payload
      })
    } else {
      this.log('info', 'None of the listed error found for this page')
    }
  }

  // ////////
  // PILOT //
  // ////////
  async navigateToContactInformation() {
    this.log('info', '📍️ navigateToContactInformation starts')
    await this.waitForElementInWorker(
      'a[href="/clients/mon-compte/mes-infos-de-contact"]'
    )
    await this.runInWorker(
      'click',
      'a[href="/clients/mon-compte/mes-infos-de-contact"]'
    )
    await Promise.race([
      this.waitForErrors(),
      this.waitForElementInWorker(
        'h1[class="text-headline-xl d-block mt-std--medium-down"]'
      )
    ])
    await this.runInWorkerUntilTrue({ method: 'checkInfosPageTitle' })
  }

  async waitForErrors() {
    this.log('info', '📍️ waitForErrors starts')
    await new Promise(resolve => {
      const listener = ({ event, payload }) => {
        if (event === 'errorDetected') {
          this.log(
            'warn',
            `waitForErrors resolved with ${event} => error ${payload}`
          )
          resolve()
        }
      }
      this.bridge.addEventListener('workerEvent', listener)
    })
  }

  async reloadPageOnError() {
    this.log('info', '📍️ reloadPageOnError starts')
    await this.evaluateInWorker(function reloadErrorPage() {
      window.location.reload()
    })
    // As this function is generic, we need to race every awaited elements
    // and possible errors elements during the entire konnector's execution
    await Promise.race([
      this.waitForElementInWorker('.cadre2'),
      this.waitForElementInWorker('.arrondi-04:not(img)'),
      this.waitForElementInWorker('a[href="javascript:history.back();"]'),
      this.waitForElementInWorker('img[src*="/page-404.png"]')
    ])
    if (
      (await this.isElementInWorker('a[href="javascript:history.back();"]')) ||
      (await this.isElementInWorker('img[src*="/page-404.png"]'))
    ) {
      return false
    }
    if (await this.isElementInWorker('.cadre2')) {
      return true
    }
    // We need to precise no images here, the class is used on the image shown on a 404 error
    if (await this.isElementInWorker('.arrondi-04:not(img)')) {
      return true
    }
    // If there is no body, it means we found another error after the reload
    // as the checking function remove the complete body before sending the error to the pilot
    if (!(await this.isElementInWorker('body'))) {
      return false
    }
  }

  async handleError() {
    this.log('info', '📍️ handleError starts')
    this.log(
      'warn',
      `Error ${this.store.foundError.payload} found on page change, trying to reload`
    )
    await this.evaluateInWorker(async function removeErrorBody() {
      document.querySelector('body').remove()
    })
    const isSuccess = await this.reloadPageOnError()
    if (!isSuccess) {
      throw new Error('VENDOR_DOWN')
    }
    // Removing error object if reload works out so it is not present on the next check
    delete this.store.foundError
  }

  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm starts')
    await this.goto(baseUrl)
    await Promise.race([
      this.waitForErrors(),
      this.waitForElementInWorker('.menu-p-btn-ec'),
      this.waitForElementInWorker('#formz-authentification-form-login')
    ])
    if (this.store.foundError) {
      await this.handleError()
    }
    if (await this.isElementInWorker('#formz-authentification-form-login')) {
      this.log('info', 'baseUrl leads to loginForm, continue')
      return
    }
    await this.runInWorker('click', '.menu-p-btn-ec')
    await Promise.race([
      this.waitForElementInWorker('#formz-authentification-form-login'),
      this.waitForElementInWorker(
        'a[href="/clients/mon-compte/gerer-mes-comptes"]'
      )
    ])
  }

  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 ensureAuthenticated starts')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()
    const credentials = await this.getCredentials()
    if (credentials) {
      const auth = await this.authWithCredentials(credentials)
      if (auth) {
        return true
      }
      return false
    }
    if (!credentials) {
      const auth = await this.authWithoutCredentials()
      if (auth) {
        return true
      }
      return false
    }
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated starts')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'not auth returning true')
      return true
    }
    this.log('info', 'auth detected, logging out')
    await this.runInWorker(
      'click',
      'a[href*="/clients/connexion?logintype=logout"]'
    )
    await this.waitForElementInWorker('#formz-authentification-form-login')
    return true
  }

  async waitForUserAuthentication() {
    this.log('info', 'waitForUserAuthentication starts')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite starts')
    await Promise.race([
      this.waitForElementInWorker('.cadre2'),
      this.waitForErrors()
    ])
    if (this.store.foundError) {
      await this.handleError()
    }
    const isContractSelectionPage = await this.evaluateInWorker(
      function checkContractSelectionPage() {
        if (document.location.href.includes('/clients/selection-compte'))
          return true
        else return false
      }
    )
    if (isContractSelectionPage) {
      this.log('info', 'Landed on the contracts selection page after login')
      const foundContractsNumber = await this.getNumberOfContracts()
      this.log('info', `Found ${foundContractsNumber} contracts`)
      numberOfContracts = foundContractsNumber
      await this.runInWorker('selectContract', 0)
      await Promise.race([
        this.waitForElementInWorker('.cadre2'),
        this.waitForErrors()
      ])
      if (this.store.foundError) {
        await this.handleError()
      }
    } else {
      this.log('info', 'Landed on the home page after login')
      const changeAccountLink = await this.isElementInWorker(
        'a[href="/clients/mon-compte/gerer-mes-comptes"]'
      )
      if (changeAccountLink) {
        await this.runInWorker('removeElement', '.cadre2')
        await this.clickAndWait(
          'a[href="/clients/mon-compte/gerer-mes-comptes"]',
          '.cadre2'
        )
        const foundContractsNumber = await this.getNumberOfContracts()
        this.log('info', `Found ${foundContractsNumber} contracts`)
        numberOfContracts = foundContractsNumber
        await this.runInWorker('selectContract', 0)
        await Promise.race([
          this.waitForElementInWorker('.cadre2'),
          this.waitForErrors()
        ])
        if (this.store.foundError) {
          await this.handleError()
        }
      }
    }
    await pRetry(this.navigateToContactInformation.bind(this), {
      retries: 5,
      onFailedAttempt: error => {
        this.log(
          'info',
          `Attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`
        )
      }
    })
    await this.runInWorker('getIdentity')
    if (numberOfContracts > 1) {
      this.log('info', 'Found more than 1 contract, fetching addresses')
      await this.goto(contractSelectionPage)
      await this.waitForElementInWorker('a[href*="?tx_demmcompte"]')
      await this.runInWorkerUntilTrue({ method: 'checkAddressesElement' })
      const addresses = await this.runInWorker('getOtherContractsAddresses')
      const clientRefs = await this.runInWorker('getOtherContractsReferences')
      let i = 0
      if (!addresses.length) {
        this.log('warn', 'No addresses found for other contracts')
      } else {
        for (const address of addresses) {
          this.store.userIdentity.address.push(address)
          this.store.userIdentity.clientRefs.push({
            linkedAddress: address.formattedAddress,
            contractNumber: clientRefs[i]
          })
          i++
        }
      }
      await this.navigateToPersonnalInfos()
    }
    if (this.store.userIdentity) {
      return { sourceAccountIdentifier: this.store.userIdentity.email }
    } else {
      throw new Error(
        'No sourceAccountIdentifier, the konnector should be fixed'
      )
    }
  }

  async selectContract(number) {
    this.log('info', '🤖 selectContract starts')
    this.log('info', `selectContract - number is ${number}`)
    const contractElements = document.querySelectorAll('.cadre2')
    const elementToClick = contractElements[number].querySelector(
      'a[href*="?tx_demmcompte"]'
    )
    // Depending on where you come from, the page will have different selectors for the same button
    // It may also not present the contract's selection button for the active contract
    // so as we need to reach back the home page anyway, if the selector is not found we just load the homePage
    if (elementToClick) {
      this.log('info', 'selectContract - elementToClick found')
      elementToClick.click()
      for (const element of contractElements) {
        element.remove()
      }
    } else {
      this.log(
        'info',
        'selectContract - elementToClick not found, changing href'
      )
      for (const element of contractElements) {
        element.remove()
      }
      document.location.href = 'https://www.totalenergies.fr/clients/accueil'
    }
  }

  async getNumberOfContracts() {
    this.log('info', 'getNumberOfContracts starts')
    await this.waitForElementInWorker('.cadre2')
    const numberOfContracts = await this.evaluateInWorker(
      function getContractsLength() {
        const contractElements = document.querySelectorAll('.cadre2')
        const foundContractsLength = contractElements.length
        return foundContractsLength
      }
    )
    return numberOfContracts
  }

  async fetch(context) {
    this.log('info', '🤖 fetch starts')
    await this.saveIdentity(this.store.userIdentity)
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    for (let i = 0; i < numberOfContracts; i++) {
      const billsDone = await this.fetchBills()
      if (billsDone) {
        // Some retrieved files may not have an amount associated (some schedules for example)
        // so wee need to sort those out before saving to avoid errors in saveBills
        const bills = []
        const files = []
        for (const oneDoc of this.store.allDocuments) {
          if (oneDoc.amount) {
            bills.push(oneDoc)
          } else {
            files.push(oneDoc)
          }
        }
        await this.saveBills(bills, {
          context,
          fileIdAttributes: ['vendorRef', 'filename'],
          contentType: 'application/pdf',
          qualificationLabel: 'energy_invoice',
          subPath: `${this.store.userIdentity.clientRefs[i].contractNumber} - ${this.store.userIdentity.clientRefs[i].linkedAddress}`
        })
        await this.saveFiles(files, {
          context,
          fileIdAttributes: ['vendorRef', 'filename'],
          contentType: 'application/pdf',
          qualificationLabel: 'energy_invoice',
          subPath: `${this.store.userIdentity.clientRefs[i].contractNumber} - ${this.store.userIdentity.clientRefs[i].linkedAddress}`
        })
        // If i > 0 it means we're in older contracts, and for them there is no contract's pdf to download
        // So we avoid the contract page
        if (i === 0) {
          await this.fetchContracts()
          await this.saveFiles(this.store.contract, {
            context,
            fileIdAttributes: ['filename'],
            contentType: 'application/pdf',
            qualificationLabel: 'energy_contract',
            subPath: `${this.store.userIdentity.clientRefs[i].contractNumber} - ${this.store.userIdentity.clientRefs[i].linkedAddress}`
          })
        }
      }
      if (numberOfContracts > 1 && i + 1 < numberOfContracts) {
        this.log(
          'info',
          'More than 1 contract found, fetching bills and contract pdfs for the others'
        )
        await this.runInWorker('removeElement', '.cadre2')
        await this.goto(contractSelectionPage)
        await this.waitForElementInWorker('.cadre2')
        await this.runInWorker('selectContract', i + 1)
        await Promise.race([
          this.waitForElementInWorker(
            'a[href="/clients/mon-compte/gerer-mes-comptes"]'
          ),
          this.waitForErrors()
        ])
        if (this.store.foundError) {
          await this.handleError()
        }
        await this.runInWorker(
          'removeElement',
          'a[href="/clients/mes-factures/mon-historique-de-factures"]'
        )
        await this.goto(contactInfosPage)
        await Promise.race([
          this.waitForElementInWorker(
            'a[href="/clients/mes-factures/mon-historique-de-factures"]'
          ),
          this.waitForErrors()
        ])
        if (this.store.foundError) {
          await this.handleError()
        }
      }
    }
  }

  async fetchBills() {
    this.log('info', 'fetchBills starts')
    await this.clickAndWait(
      'a[href="/clients/mes-factures"]',
      'a[href="/clients/mes-factures/mon-historique-de-factures"]'
    )
    await this.clickAndWait(
      'a[href="/clients/mes-factures/mon-historique-de-factures"]',
      '.detail-facture'
    )
    const billsDone = await this.runInWorker('getBills')
    return billsDone
  }

  async fetchContracts() {
    this.log('info', 'fetchContracts starts')
    await this.clickAndWait(
      'a[href="/clients/mon-compte/mon-contrat"]',
      '.cadre2'
    )
    await this.runInWorkerUntilTrue({ method: 'checkContractPageTitle' })
    await this.runInWorker('getContract')
  }

  async authWithCredentials(credentials) {
    this.log('info', 'auth with credentials starts')
    await Promise.race([
      this.waitForElementInWorker(
        'a[href*="/clients/connexion?logintype=logout"]'
      ),
      this.waitForElementInWorker('#formz-authentification-form-login')
    ])
    const alreadyLoggedIn = await this.runInWorker('checkIfLogged')
    if (alreadyLoggedIn) {
      return true
    } else {
      await this.tryAutoLogin(credentials)
      await Promise.race([
        this.waitForElementInWorker('#captcha_audio'),
        this.waitForElementInWorker(
          'a[href="/clients/mon-compte/gerer-mes-comptes"]'
        ),
        this.waitForElementInWorker('.cadre2')
      ])
      const isAskingCaptcha = await this.runInWorker('checkIfAskingCaptcha')
      if (isAskingCaptcha) {
        this.log(
          'info',
          'Webiste is asking for captcha completion. Showing page to user'
        )
        await this.waitForUserAuthentication()
      }
    }
  }

  async authWithoutCredentials() {
    this.log('info', 'auth without credentials starts')
    const maintenanceStatus = await this.runInWorker('checkMaintenanceStatus')
    if (maintenanceStatus) {
      throw new Error('VENDOR_DOWN')
    }
    await this.waitForElementInWorker('#formz-authentification-form-password')
    await this.waitForUserAuthentication()
    return true
  }

  async tryAutoLogin(credentials) {
    this.log('debug', 'Trying auto login')
    await this.autoLogin(credentials)
    if (await this.checkAuthenticated()) {
      return true
    }
  }

  async autoLogin(credentials) {
    this.log('info', 'AutoLogin starts')
    await this.waitForElementInWorker('#formz-authentification-form-login')
    await this.runInWorker('fillingForm', credentials)
    await this.runInWorker(
      'click',
      '#formz-authentification-form-reste-connecte'
    )
    await this.runInWorker('click', '#js--btn-validation')
  }

  async navigateToPersonnalInfos() {
    this.log('info', 'navigateToPersonnalInfos starts')
    await this.runInWorker('selectContract', 0)
    await Promise.race([
      Promise.all([
        this.waitForElementInWorker(
          'a[href*="/clients/connexion?logintype=logout"]'
        ),
        this.waitForElementInWorker(
          'a[href="/clients/mon-compte/gerer-mes-comptes"]'
        ),
        this.waitForElementInWorker(
          'a[href="/clients/mon-compte/mes-infos-de-contact"]'
        )
      ]),
      this.waitForErrors()
    ])
    if (this.store.foundError) {
      await this.handleError()
    }
    await this.runInWorker(
      'click',
      'a[href="/clients/mon-compte/mes-infos-de-contact"]'
    )
    await Promise.race([
      this.waitForElementInWorker(
        'h1[class="text-headline-xl d-block mt-std--medium-down"]'
      ),
      this.waitForErrors()
    ])
    if (this.store.foundError) {
      await this.handleError()
    }
    await this.runInWorkerUntilTrue({ method: 'checkInfosPageTitle' })
  }

  // ////////
  // WORKER//
  // ////////

  async checkAuthenticated() {
    this.log('info', 'checkAuthenticated starts')
    const loginField = document.querySelector(
      '#formz-authentification-form-login'
    )
    const passwordField = document.querySelector(
      '#formz-authentification-form-password'
    )
    if (loginField && passwordField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('debug', 'Sendin userCredentials to Pilot')
      this.sendToPilot({
        userCredentials
      })
    }
    // Here the type of check depend on session.
    // If the session is active at konnector start, then the landing page is '/clients/accueil'
    // If the connection has just been made (by the user or with autoLogin), we land on the second if's url (HOMEPAGE_URL)
    if (
      document.location.href ===
        'https://www.totalenergies.fr/clients/accueil' &&
      document.querySelector('a[href="/clients/mon-compte/gerer-mes-comptes"]')
    ) {
      this.log('info', 'connected from session')
      return true
    }
    if (
      document.location.href === HOMEPAGE_URL &&
      document.querySelector('a[href="/clients/mon-compte/gerer-mes-comptes"]')
    ) {
      this.log('info', 'Auth Check succeeded')
      return true
    }
    if (document.location.href.includes('/clients/selection-compte')) {
      this.log('info', 'Auth check OK, need to choose a contract')
      return true
    }
    return false
  }

  async findAndSendCredentials(login, password) {
    this.log('debug', 'findAndSendCredentials starts')
    let userLogin = login.value
    let userPassword = password.value
    const userCredentials = {
      login: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  async clickLoginPage() {
    const loginPageButton = this.getLoginPageButton()
    if (loginPageButton) {
      loginPageButton.click()
      return true
    }
    this.log('debug', 'No loginPage found')
    return false
  }

  getLoginPageButton() {
    const loginPageButton = document.querySelector('a[class="menu-p-btn-ec"]')
    return loginPageButton
  }

  async checkMaintenanceStatus() {
    const isInMaintenance = this.checkMaintenanceMessage()
    if (isInMaintenance) {
      return true
    }
    return false
  }

  checkMaintenanceMessage() {
    const maintenanceMessage = document.querySelector('.big')?.innerHTML
    if (
      document.location.href === MAINTENANCE_URL &&
      maintenanceMessage.includes('maintenance')
    ) {
      this.log('warn', 'Website is under maintenance')
      return true
    } else if (document.location.href === MAINTENANCE_URL) {
      this.log('warn', `Website encounter a problem : ${maintenanceMessage}`)
      return true
    } else {
      return false
    }
  }

  async checkIfLogged() {
    if (
      document.querySelector('a[href*="/clients/connexion?logintype=logout"]')
    ) {
      return true
    }
    return false
  }

  fillingForm(credentials) {
    const loginField = document.querySelector(
      '#formz-authentification-form-login'
    )
    const passwordField = document.querySelector(
      '#formz-authentification-form-password'
    )
    this.log('debug', 'Filling fields with credentials')
    loginField.value = credentials.login
    passwordField.value = credentials.password
  }

  async getIdentity() {
    this.log('info', 'getIdentity starts')
    const infosElements = document.querySelectorAll('.arrondi-04')
    const familyName = infosElements[0].children[0].textContent.split(':')[1]
    const name = infosElements[0].children[1].textContent.split(':')[1]
    const clientRef = infosElements[0].children[2].textContent.split(':')[1]
    const phoneNumber = infosElements[1].children[0].textContent.split(':')[1]
    const email = infosElements[1].children[1].textContent.split(':')[1].trim()
    const rawAddress = infosElements[2].children[0].textContent.replace(
      / {2}/g,
      ' '
    )
    let splittedAddress
    if (rawAddress.includes('<Br/>')) {
      let cleanedAddress
      cleanedAddress = rawAddress.replace(/ <Br\/>/g, '')
      splittedAddress = cleanedAddress.match(
        /([0-9A-Za-z-'\s]*) ([\d]{5}) ([a-zA-Z-']*)/
      )
    } else {
      splittedAddress = rawAddress.match(
        /([0-9A-Za-z-'\s]*) ([\d]{5}) ([a-zA-Z-']*)/
      )
    }
    const [fullAddress, street, postCode, city] = splittedAddress

    const userIdentity = {
      email,
      clientRefs: [
        {
          linkedAddress: fullAddress,
          contractNumber: clientRef
        }
      ],
      name: {
        givenName: name,
        familyName
      },
      address: [
        {
          formattedAddress: fullAddress,
          street,
          postCode,
          city
        }
      ],
      phone: [
        {
          type: phoneNumber.match(/^06|07|\+336|\+337/g) ? 'mobile' : 'home',
          number: phoneNumber
        }
      ]
    }
    await this.sendToPilot({ userIdentity })
  }

  async getBills() {
    this.log('info', 'getBills starts')
    const invoices = await this.getInvoices()
    const schedules = await this.getSchedules()
    const allDocuments = await this.computeInformations(invoices, schedules)
    await this.sendToPilot({ allDocuments })
    return true
  }

  async getContract() {
    this.log('info', 'getContract starts')
    const contractElement = document.querySelector('.arrondi-04')
    const offerName = contractElement.querySelector('h2').innerHTML
    const rawStartDate = contractElement.querySelector(
      'p[class="font-700"]'
    ).innerHTML
    const splittedStartDate = rawStartDate.split('/')
    const day = splittedStartDate[0]
    const month = splittedStartDate[1]
    const year = splittedStartDate[2]
    const startDate = new Date(year, month, day)
    const href = contractElement
      .querySelector('a[href*="/telechargement-des-contrats"]')
      .getAttribute('href')
    const fileurl = `https://www.totalenergies.fr${href}`
    const filename = `${year}-${month}-${day}_TotalEnergie_Contrat_${offerName.replaceAll(
      ' ',
      '-'
    )}.pdf`
    const contract = [
      {
        filename,
        fileurl,
        fileIdAttributes: ['filename'],
        vendor: 'Total Energies',
        offerName,
        fileAttributes: {
          metadata: {
            contentAuthor: 'totalenergies.fr',
            issueDate: new Date(),
            datetime: startDate,
            datetimeLabel: 'startDate',
            carbonCopy: true
          }
        }
      }
    ]
    await this.sendToPilot({ contract })
  }

  getInvoices() {
    this.log('info', 'getInvoices starts')
    const invoices = document.querySelectorAll('div[class="detail-facture"]')
    return invoices
  }

  getSchedules() {
    this.log('info', 'getSchedules starts')
    const schedulesInfos = document.querySelectorAll(
      '.action__condition-conteneur-label'
    )
    // const schedulesUrl = document.querySelectorAll('.action__display-zone > div[class="text-center mt-std"] > a')
    let schedules = []
    for (let i = 0; i < schedulesInfos.length; i++) {
      const schedulesObject = {
        element: schedulesInfos[i],
        downloadButton:
          schedulesInfos[i].nextElementSibling.children[1].children[0]
      }
      schedules.push(schedulesObject)
    }
    return schedules
  }

  computeInformations(invoices, schedules) {
    this.log('info', 'computeInformations starts')
    let computedInvoices = []
    for (let i = 0; i < invoices.length; i++) {
      const vendorRef =
        invoices[i].children[0].children[2].innerHTML.match(/N° (.*)/)[1]
      const docTitle = invoices[i].children[0].children[0].innerHTML
      const rawDate = invoices[i].children[1].innerHTML
      const splitDate = rawDate.split('/')
      const day = splitDate[0]
      const month = splitDate[1]
      const year = splitDate[2]
      const rawPaymentStatus = invoices[i].children[2].innerHTML
      const paymentStatus = this.findBillStatus(rawPaymentStatus)
      const href = invoices[i].children[4].getAttribute('href')
      const fileurl = `https://www.totalenergies.fr${href}`
      const date = new Date(`${month}/${day}/${year}`)
      let invoice = {
        docTitle,
        vendorRef,
        date,
        fileurl,
        fileIdAttributes: ['vendorRef'],
        vendor: 'Total Energies',
        fileAttributes: {
          metadata: {
            contentAuthor: 'totalenergies.fr',
            issueDate: new Date(),
            datetime: date,
            datetimeLabel: `issueDate`,
            invoiceNumber: `${vendorRef}`,
            isSubscription: true,
            carbonCopy: true
          }
        }
      }
      switch (paymentStatus) {
        case 'Paid':
          invoice.paymentStatus = paymentStatus
          if (rawPaymentStatus.match(/[0-9]{2}\/[0-9]{2}\/[0-9]{4}/g)) {
            invoice.paymentStatusDate = rawPaymentStatus.match(
              /[0-9]{2}\/[0-9]{2}\/[0-9]{4}/g
            )[0]
          } else {
            this.log('warn', 'No date found for this payment status')
          }
          break
        case 'Refunded':
          invoice.paymentStatus = paymentStatus
          if (rawPaymentStatus.match(/[0-9]{2}\/[0-9]{2}\/[0-9]{4}/g)) {
            invoice.paymentStatusDate = rawPaymentStatus.match(
              /[0-9]{2}\/[0-9]{2}\/[0-9]{4}/g
            )[0]
          } else {
            this.log('warn', 'No date found for this payment status')
          }
          invoice.isRefund = true
          break
        default:
          invoice.paymentStatus = paymentStatus
          break
      }
      const rawCurrency = invoices[i].children[3].innerHTML.match(/€|\$|£/g)
      let currency
      const rawAmount = invoices[i].children[3].innerHTML.match(
        /([0-9]){1,},([0-9]){1,2}/g
      )
      let amount
      if (rawCurrency != null) {
        currency = rawCurrency === '€' ? 'EUR' : rawCurrency[0]
        invoice.currency = currency
      }
      if (rawAmount != null) {
        amount = parseFloat(rawAmount[0].replace(',', '.'))
        invoice.amount = amount
      }
      if (currency && amount) {
        invoice.filename = `${year}-${month}-${day}_TotalEnergies_${docTitle.replace(
          / /g,
          '-'
        )}_${amount}${currency}.pdf`
      } else {
        this.log('info', 'No couple amount/currency for this bill')
        invoice.filename = `${year}-${month}-${day}_TotalEnergies_${docTitle.replace(
          / /g,
          '-'
        )}.pdf`
      }
      computedInvoices.push(invoice)
    }
    let computedSchedules = []
    this.log('info', 'computing schedules')
    for (let j = 0; j < schedules.length; j++) {
      const vendorRef =
        schedules[j].element.children[0].children[2].innerHTML.match(
          /N° (.*)/
        )[1]
      const docTitle = schedules[j].element.children[0].children[0].innerHTML
      const rawDate = schedules[j].element.children[1].innerHTML
      const splitDate = rawDate.split('/')
      const day = splitDate[0]
      const month = splitDate[1]
      const year = splitDate[2]
      const rawPaymentStatus = schedules[j].element.children[2].innerHTML
      const paymentStatus = this.findBillStatus(rawPaymentStatus)
      const rawAmount = schedules[j].element.children[3].innerHTML.match(
        /([0-9]){1,},([0-9]){1,2}/g
      )
      const rawCurrency =
        schedules[j].element.children[3].innerHTML.match(/€|\$|£/g)
      const currency = rawCurrency === '€' ? 'EUR' : rawCurrency[0]
      const href = schedules[j].downloadButton.getAttribute('href')
      const fileurl = `https://www.totalenergies.fr${href}`
      const amount = parseFloat(rawAmount[0].replace(',', '.'))
      const date = new Date(`${month}/${day}/${year}`)
      let schedule = {
        docTitle,
        filename: `${year}-${month}-${day}_TotalEnergies_${docTitle.replace(
          / /g,
          '-'
        )}_${amount}${currency}.pdf`,
        vendorRef,
        amount,
        date,
        currency,
        fileurl,
        fileIdAttributes: ['vendorRef'],
        vendor: 'Total Energies',
        fileAttributes: {
          metadata: {
            contentAuthor: 'totalenergies.fr',
            issueDate: new Date(),
            datetime: date,
            datetimeLabel: `issueDate`,
            invoiceNumber: `${vendorRef}`,
            isSubscription: true,
            carbonCopy: true
          }
        }
      }
      switch (paymentStatus) {
        case 'Paid':
          schedule.paymentStatus = paymentStatus
          schedule.paymentStatusDate = rawPaymentStatus.match(
            /([0-9]{2}\/[0-9]{2}\/[0-9]{4})/
          )
          break
        case 'Refunded':
          schedule.paymentStatus = paymentStatus
          schedule.paymentStatusDate = rawPaymentStatus.match(
            /[0-9]{2}\/[0-9]{2}\/[0-9]{4}/
          )
          schedule.isRefunded = true
          break
        default:
          schedule.paymentStatus = paymentStatus
          break
      }
      computedSchedules.push(schedule)
    }
    const computedDocs = computedInvoices.concat(computedSchedules)
    return computedDocs
  }

  findBillStatus(rawPaymentStatus) {
    if (rawPaymentStatus.match('Payée')) {
      return 'Paid'
    } else if (rawPaymentStatus.match('Terminé')) {
      return 'Ended'
    } else if (rawPaymentStatus.match('Remboursée')) {
      return 'Refunded'
    } else if (rawPaymentStatus === '') {
      this.log('debug', 'No status for this file')
      return 'No status'
    } else {
      this.log('debug', 'Unknown status, returning as it is')
      return rawPaymentStatus
    }
  }

  async checkInfosPageTitle() {
    this.log('info', 'checkInfosPageTitle starts')
    await waitFor(
      () => {
        const pageTitle = document.querySelector(
          'h1[class="text-headline-xl d-block mt-std--medium-down"]'
        )?.textContent
        if (pageTitle === ' Mes infos de contact ') {
          return true
        } else {
          return false
        }
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 30000,
          message: new TimeoutError(
            'checkInfosPageTitle timed out after 30 secondes'
          )
        }
      }
    )
    return true
  }

  async checkContractPageTitle() {
    this.log('info', 'checkContractPageTitle')
    await waitFor(
      () => {
        const pageTitle = document.querySelector(
          'h1[class="text-headline-xl d-block mt-std--medium-down"]'
        ).textContent
        if (pageTitle === ' Mon contrat ') {
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 30000,
          message: new TimeoutError(
            'checkContractPageTitle timed out after 30 secondes'
          )
        }
      }
    )
    return true
  }

  checkIfAskingCaptcha() {
    this.log('info', 'checkIfAskingCaptcha starts')
    const isCaptchaPage = document.querySelector('#captcha_audio')
    const captchaTitle = document.querySelector('h2')?.textContent

    if (isCaptchaPage && captchaTitle === 'Non, je ne suis pas un robot !') {
      return true
    }
    return false
  }

  async checkAddressesElement() {
    this.log('info', '📍️ checkAddressesElement starts')
    await waitFor(
      () => {
        const elements = document.querySelectorAll('.cadre2')
        const readyElements = []
        for (const element of elements) {
          const foundAddress = element
            .querySelector('div[class="mt-dm largeur-auto"]')
            .textContent.replace(/(?<=\s)\s+(?=\s)/g, '')
            .replace(/\n/g, '')
          const [, postCodeAndCity] = foundAddress.split(', ')
          if (postCodeAndCity === undefined) {
            this.log('debug', 'postCodeAndCity is undefined')
            continue
          } else {
            this.log('debug', 'element ready')
            readyElements.push(element)
          }
        }
        if (readyElements.length === elements.length) {
          this.log('debug', 'same length for both arrays')
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  getOtherContractsAddresses() {
    this.log('info', 'getOtherContractsAddresses starts')
    let addresses = []
    const elements = document.querySelectorAll('.cadre2')
    // i = 1 because we dont need the first addresse, we already get it
    for (let i = 1; i < elements.length; i++) {
      const foundAddress = elements[i]
        .querySelector('div[class="mt-dm largeur-auto"]')
        .textContent.replace(/(?<=\s)\s+(?=\s)/g, '')
        .replace(/\n/g, '')
        .trim()
      if (!foundAddress) {
        this.log('warn', `No addresse found for ${i} contract`)
        continue
      }
      const postCode = foundAddress.match(/\d{5}/g)[0]
      if (!postCode) {
        this.log(
          'warn',
          `Addresse was found but no postCode match, abort addresse fetching for ${i} contract`
        )
        continue
      } else {
        const matchedAddress = foundAddress.match(
          /([\s\S]+?)\s*,?\s*(\d{5})\s+([\s\S]+)/
        )
        const [, street, postCode, city] = matchedAddress
        const formattedAddress = `${street} ${postCode} ${city}`.trim()
        addresses.push({
          street,
          postCode,
          city,
          formattedAddress
        })
      }
    }
    return addresses
  }

  getOtherContractsReferences() {
    this.log('info', 'getOtherContractsReferences starts')
    let clientRefs = []
    const elements = document.querySelectorAll('.cadre2')
    // i = 1 because we dont need the first addresse, we already get it
    for (let i = 1; i < elements.length; i++) {
      const foundRef = elements[i].querySelector(
        'div[class*="js--partenaire-id-"]'
      ).textContent
      const foundClientRef = foundRef.split(' -')[0]
      const clientRef = foundClientRef.trim()
      clientRefs.push(clientRef)
    }
    return clientRefs
  }

  removeElement(element) {
    this.log('info', 'removeElement starts')
    // Here we're removing all element with .cadre2 class as we're gonna
    // use this class to know when we reached the contract selection page
    const elements = document.querySelectorAll(element)
    for (const element of elements) {
      element.remove()
    }
  }
}

const connector = new TemplateContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'clickLoginPage',
      'checkMaintenanceStatus',
      'getBills',
      'fillingForm',
      'checkIfLogged',
      'getIdentity',
      'getContract',
      'checkInfosPageTitle',
      'checkContractPageTitle',
      'checkIfAskingCaptcha',
      'checkAddressesElement',
      'getOtherContractsAddresses',
      'getOtherContractsReferences',
      'selectContract',
      'removeElement'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
