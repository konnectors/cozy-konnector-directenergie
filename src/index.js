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
// const contactInfosPage =
//   'https://www.totalenergies.fr/clients/mon-compte/mes-infos-de-contact'
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
    const isError500 = currentBody?.innerHTML.match(
      'Error 500 - Internal Server Error'
    )
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
    } else if (isError500) {
      this.log('info', 'Found error 500')
      const event = 'errorDetected'
      const payload = '500'
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
      this.waitForElementInWorker('main > div > h1')
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
    const credentials = await this.getCredentials()
    if (!account || !credentials) {
      await this.ensureNotAuthenticated()
      await this.waitForUserAuthentication()
    } else {
      await this.navigateToLoginForm()
      const auth = await this.authWithCredentials(credentials)
      if (auth) {
        return true
      }
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
    let uniqContract = false
    await Promise.race([
      this.waitForElementInWorker('.cadre2'),
      this.waitForErrors()
    ])
    if (this.store.foundError) {
      await this.handleError()
    }
    let isContractSelectionPage = await this.evaluateInWorker(
      function checkContractSelectionPage() {
        if (document.location.href.includes('/clients/selection-compte'))
          return true
        else return false
      }
    )
    if (!isContractSelectionPage) {
      this.log('info', 'Landed on the home page after login')
      const changeAccountLink = await this.isElementInWorker(
        'a[href="/clients/mon-compte/gerer-mes-comptes"]'
      )
      if (changeAccountLink) {
        await this.clickAndWait(
          'a[href="/clients/mon-compte/gerer-mes-comptes"]',
          '[id*="js--listjs-comptes-"]'
        )
        isContractSelectionPage = true
      } else {
        this.log('info', 'Only found 1 contract')
        uniqContract = true
      }
    } else {
      this.log('info', 'Landed on the contracts selection page after login')
    }
    if (!uniqContract) {
      const foundContractsNumber = await this.getNumberOfContracts()
      this.log('info', `Found ${foundContractsNumber} contracts`)
      numberOfContracts = foundContractsNumber
    }
    await this.runInWorker('getContractsInfos', numberOfContracts)
    if (isContractSelectionPage) {
      await this.runInWorker('selectContract', 0)
      await Promise.race([
        this.waitForElementInWorker('.cadre2'),
        this.waitForErrors()
      ])
      if (this.store.foundError) {
        await this.handleError()
      }
    }
    if (
      await this.isElementInWorker(
        'a[href="/clients/mon-compte/mes-infos-de-contact"]'
      )
    ) {
      await pRetry(this.navigateToContactInformation.bind(this), {
        retries: 5,
        onFailedAttempt: error => {
          this.log(
            'info',
            `Attempt ${error.attemptNumber} failed. There are ${error.retriesLeft} retries left.`
          )
        }
      })
    } else {
      this.log(
        'warn',
        'Identty could not be fetched, impossible to reach userInfos page, will use user login as sourceAccountIdentifier'
      )
    }
    const savedCredentials = await this.getCredentials()
    const userLogin = savedCredentials
      ? savedCredentials.login
      : this.store.userCredentials.login
    if (this.store.userIdentity || userLogin) {
      return {
        sourceAccountIdentifier: this.store.userIdentity
          ? this.store.userIdentity.email
          : userLogin
      }
    } else {
      throw new Error(
        'No sourceAccountIdentifier, the konnector should be fixed'
      )
    }
  }

  async selectContract(number) {
    this.log('info', '🤖 selectContract starts')
    this.log('info', `selectContract - number is ${number}`)
    const activeContractsElement = document.querySelector(
      '#js--listjs-comptes-actifs'
    )
    const terminatedContractsElement = document.querySelector(
      '#js--listjs-comptes-resilies'
    )
    const allContractsElements = []
    if (activeContractsElement) {
      activeContractsElement.querySelectorAll('ul > li').forEach(element => {
        allContractsElements.push(element)
      })
    }
    if (terminatedContractsElement) {
      terminatedContractsElement
        .querySelectorAll('ul > li')
        .forEach(element => {
          allContractsElements.push(element)
        })
    }
    const elementToClick = allContractsElements[number].querySelector(
      'a[href*="?tx_demmcompte"]'
    )
    // Depending on where you come from, the page will have different selectors for the same button
    // It may also not present the contract's selection button for the active contract
    // so as we need to reach back the home page anyway, if the selector is not found we just load the homePage
    if (elementToClick) {
      this.log('info', 'selectContract - elementToClick found')
      elementToClick.click()
    } else {
      this.log(
        'info',
        'selectContract - elementToClick not found, changing href'
      )
      for (const element of allContractsElements) {
        element.remove()
      }
      document.location.href = 'https://www.totalenergies.fr/clients/accueil'
    }
  }

  async getNumberOfContracts() {
    this.log('info', 'getNumberOfContracts starts')
    await this.waitForElementInWorker('[id*="js--listjs-comptes-"]')
    const numberOfContracts = await this.evaluateInWorker(
      function getContractsLength() {
        const activeContractsElement = document.querySelector(
          '#js--listjs-comptes-actifs'
        )
        const terminatedContractsElement = document.querySelector(
          '#js--listjs-comptes-resilies'
        )
        let activeLength = 0
        let terminatedLength = 0
        // Not knowing if all contract elements are also present in html when the user have none
        // we need to check before trying to get it's length
        if (activeContractsElement) {
          activeLength =
            activeContractsElement.querySelectorAll('ul > li').length
        }
        if (terminatedContractsElement) {
          terminatedLength =
            terminatedContractsElement.querySelectorAll('ul > li').length
        }
        const foundContractsLength = activeLength + terminatedLength
        return { foundContractsLength, activeLength, terminatedLength }
      }
    )
    this.log('info', `Found ${numberOfContracts.activeLength} active contracts`)
    this.log(
      'info',
      `Found ${numberOfContracts.terminatedLength} terminated contracts`
    )
    return numberOfContracts.foundContractsLength
  }

  async fetch(context) {
    this.log('info', '🤖 fetch starts')
    const clientRefs = this.store.clientRefs
    if (this.store.userIdentity) {
      await this.saveIdentity(this.store.userIdentity)
    }
    if (this.store.userCredentials) {
      await this.saveCredentials(this.store.userCredentials)
    }
    for (let i = 0; i < numberOfContracts; i++) {
      const billsDone = await this.fetchBills()
      if (billsDone) {
        // Some retrieved files may not have an amount associated (some schedules for example)
        // so wee need to sort those out before saving to avoid errors in saveBills
        const gazBills = []
        const electricBills = []
        const gazFiles = []
        const electricFiles = []
        for (const oneDoc of this.store.allDocuments) {
          if (oneDoc.amount) {
            if (oneDoc.documentType === 'Gaz') {
              gazBills.push(oneDoc)
            } else {
              electricBills.push(oneDoc)
            }
          } else {
            if (oneDoc.documentType === 'Gaz') {
              gazFiles.push(oneDoc)
            } else {
              electricFiles.push(oneDoc)
            }
          }
        }
        if (electricBills.length) {
          this.log('info', 'Saving electric bills ...')
          await this.saveBills(electricBills, {
            context,
            fileIdAttributes: ['vendorRef', 'filename'],
            contentType: 'application/pdf',
            qualificationLabel: 'energy_invoice',
            subPath: `${clientRefs[i].contractNumber} - ${clientRefs[i].linkedAddress}/Électricité`
          })
        }
        if (gazBills.length) {
          this.log('info', 'Saving gaz bills ...')
          await this.saveBills(gazBills, {
            context,
            fileIdAttributes: ['vendorRef', 'filename'],
            contentType: 'application/pdf',
            qualificationLabel: 'energy_invoice',
            subPath: `${clientRefs[i].contractNumber} - ${clientRefs[i].linkedAddress}/Gaz`
          })
        }
        if (electricFiles.length) {
          this.log('info', 'Saving electric files ...')
          await this.saveFiles(electricFiles, {
            context,
            fileIdAttributes: ['vendorRef', 'filename'],
            contentType: 'application/pdf',
            qualificationLabel: 'energy_invoice',
            subPath: `${clientRefs[i].contractNumber} - ${clientRefs[i].linkedAddress}/Électricité`
          })
        }
        if (gazFiles.length) {
          this.log('info', 'Saving gaz files ...')
          await this.saveFiles(gazFiles, {
            context,
            fileIdAttributes: ['vendorRef', 'filename'],
            contentType: 'application/pdf',
            qualificationLabel: 'energy_invoice',
            subPath: `${clientRefs[i].contractNumber} - ${clientRefs[i].linkedAddress}/Gaz`
          })
        }
        // If i > 0 it means we're in older contracts, and for them there is no contract's pdf to download
        // So we avoid the contract page
        if (i === 0) {
          await this.fetchContracts()
          await this.saveFiles(this.store.contract, {
            context,
            fileIdAttributes: ['filename'],
            contentType: 'application/pdf',
            qualificationLabel: 'energy_contract',
            subPath: `${clientRefs[i].contractNumber} - ${clientRefs[i].linkedAddress}`
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
        // not knowing if we're gonna find active, terminated or both, we'll wait for incomplete id
        await this.waitForElementInWorker('[id*="js--listjs-comptes-"]')
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
      '[data-cs-override-id="offreDescription"]'
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

  async getContractsInfos(numberOfContracts) {
    this.log('info', '📍️ getContractsInfos starts')
    const clientRefs = []
    // If there is just one contract, we assume we cannot reach the chooseContract page
    // So we're scraping the contract info on homePage
    if (numberOfContracts === 1) {
      const contractInfosElement =
        document.querySelector('h1').nextElementSibling
      const foundAddress = contractInfosElement
        .querySelector('div > div > p')
        .textContent.replace(/\n/g, '')
        .replace(',', '')
        .trim()
      const foundContractRef = contractInfosElement.querySelector(
        'div > div > div > span'
      ).textContent
      clientRefs.push({
        linkedAddress: foundAddress,
        contractNumber: foundContractRef
      })
    } else {
      const { addresses, contractRefs } = await this.waitAndGetContractsInfos()
      let i = 0
      if (!addresses.length) {
        this.log('warn', 'No addresses found for all contracts')
      } else {
        for (const address of addresses) {
          if (this.store.userIdentity) {
            this.store.userIdentity.address.push(address)
          }
          clientRefs.push({
            linkedAddress: address.formattedAddress,
            contractNumber: contractRefs[i]
          })
          i++
        }
      }
    }
    await this.sendToPilot({ clientRefs })
  }

  async getIdentity() {
    this.log('info', 'getIdentity starts')
    const infosElements = document.querySelectorAll(
      '.arrondi-04 > div > p > span'
    )
    const addressElement = document.querySelector(
      '.arrondi-04 > div > .font-700'
    )
    const familyName = infosElements[0].textContent
    const name = infosElements[1].textContent
    const phoneNumber = infosElements[3].textContent
    const email = infosElements[4].textContent
    const rawAddress = addressElement.textContent.replace(/ {2}/g, ' ')
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
    const electricInvoices = await this.getElectricInvoices()
    let separationIndex
    if (electricInvoices.length) {
      separationIndex = electricInvoices.length - 1
    } else {
      separationIndex = null
    }
    const gazInvoices = await this.getGazInvoices()
    const invoices = electricInvoices.concat(gazInvoices)
    const schedules = await this.getSchedules()
    const allDocuments = await this.computeInformations(
      invoices,
      separationIndex,
      schedules
    )
    await this.sendToPilot({ allDocuments })
    return true
  }

  async getContract() {
    this.log('info', 'getContract starts')
    const contractElement = document.querySelector('.arrondi-04')
    const offerName = contractElement
      .querySelector('[data-cs-override-id="offreDescription"] > p')
      .innerHTML.replace(/  {2}|\n/g, '')
      .trim()
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

  getElectricInvoices() {
    this.log('info', 'getElectricInvoices starts')
    if (document.querySelector('#js--historique-container-elec')) {
      const invoices = Array.from(
        document
          .querySelector('#js--historique-container-elec')
          .querySelectorAll('div[class="detail-facture"]')
      )
      return invoices
    } else {
      this.log('info', 'No electricity bills found for this contract')
      return []
    }
  }
  getGazInvoices() {
    this.log('info', 'getGazInvoices starts')
    if (document.querySelector('#js--historique-container-gaz')) {
      const invoices = Array.from(
        document
          .querySelector('#js--historique-container-gaz')
          .querySelectorAll('div[class="detail-facture"]')
      )
      return invoices
    } else {
      this.log('info', 'No gaz bills found for this contract')
      return []
    }
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

  computeInformations(invoices, separationIndex, schedules) {
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
      const documentType = i > separationIndex ? 'Gaz' : 'Electricité'
      let invoice = {
        documentType,
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
        invoice.filename = `${year}-${month}-${day}_TotalEnergies_${documentType}_${docTitle.replace(
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
      const documentType = j > separationIndex ? 'Gaz' : 'Electricité'
      let schedule = {
        documentType,
        docTitle,
        filename: `${year}-${month}-${day}_TotalEnergies_${documentType}_${docTitle.replace(
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
    } else if (rawPaymentStatus.match('En cours')) {
      return 'Pending'
    } else if (
      rawPaymentStatus === '' ||
      rawPaymentStatus === '\n        \n    '
    ) {
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
        const pageTitle = document.querySelector('main > div > h1')?.textContent
        if (pageTitle === 'Mes infos de contact') {
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
        const pageTitle = document.querySelector('main > div > h1').textContent
        if (pageTitle === 'Mon contrat') {
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

  async waitAndGetContractsInfos() {
    this.log('info', '📍️ waitAndGetContractsInfos starts')
    const foundAddresses = []
    const foundContractRefs = []
    await waitFor(
      async () => {
        const activeContractsElement = document.querySelector(
          '#js--listjs-comptes-actifs'
        )
        const terminatedContractsElement = document.querySelector(
          '#js--listjs-comptes-resilies'
        )
        const allContractsElements = []
        if (activeContractsElement) {
          activeContractsElement
            .querySelectorAll('ul > li')
            .forEach(element => {
              allContractsElements.push(element)
            })
        }
        if (terminatedContractsElement) {
          terminatedContractsElement
            .querySelectorAll('ul > li')
            .forEach(element => {
              allContractsElements.push(element)
            })
        }
        for (const contractElement of allContractsElements) {
          const foundAddress = contractElement
            .querySelector('.js--listjs__item-adresse')
            .textContent.replace(/(?<=\s)\s+(?=\s)/g, '')
            .replace(/\n/g, '')
            .trim()
          const foundClientRef = contractElement.querySelector(
            '.js--listjs__item-refclient'
          ).textContent
          // Needs to be check, sometimes it has not been fully loaded on first lap
          const postCodeAndCity = foundAddress.match(
            /\b\d{5}\b\s(?:[a-zA-Z-']+\s?)+/g
          )
          if (postCodeAndCity && foundClientRef) {
            this.log('debug', 'Element ready')
            foundAddresses.push(foundAddress)
            foundContractRefs.push(foundClientRef)
          } else {
            this.log('debug', 'Element not ready')
            continue
          }
        }

        if (
          foundAddresses.length === allContractsElements.length &&
          foundContractRefs.length === allContractsElements.length
        ) {
          this.log('debug', 'Infos for all contracts found, continue')
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    const addresses = this.getContractsAddresses(foundAddresses)
    return { addresses, contractRefs: foundContractRefs }
  }

  getContractsAddresses(elements) {
    this.log('info', 'getContractsAddresses starts')
    let addresses = []
    for (let i = 0; i < elements.length; i++) {
      const matchedAddress = elements[i].match(
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
    return addresses
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
      'getContractsInfos',
      'getIdentity',
      'getContract',
      'checkInfosPageTitle',
      'checkContractPageTitle',
      'checkIfAskingCaptcha',
      'waitAndGetContractsInfos',
      'getContractsAddresses',
      'selectContract',
      'removeElement'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
