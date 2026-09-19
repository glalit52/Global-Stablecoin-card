# Product Requirements Document — Global Wealth Card

> Converted from the source `.docx` for reference alongside the implementation.
> Section numbers referenced throughout the code and commit messages point here.

Asset-Backed Credit Card + Stablecoin Payments + AI Risk + Premium Rewards
Document
Version
Status
Primary Launch Concept
Detailed PRD
1.0
Founder / Product Definition
BTC + Stablecoin-backed credit card via Visa/Mastercard
Core thesis: Build a global asset-backed spending and credit platform that lets customers use verified wealth—initially Bitcoin and stablecoins, then equities, ETFs, cash and other eligible assets—as the basis for a dynamically calculated credit line. The customer spends through a normal Visa/Mastercard card while the merchant receives ordinary fiat.
Positioning: “Spend without selling your wealth.”
Long-term category: Asset-backed consumer credit infrastructure / Global Wealth Card.
Contents

## 1. Executive Summary


## 2. Product Vision & Strategic Thesis


## 3. Problem Statement


## 4. Product Goals & Non-Goals


## 5. Target Customers & Personas


## 6. Product Principles


## 7. Core User Journeys


## 8. Product Scope


## 9. Wealth Graph & Asset Aggregation


## 10. Asset Eligibility & Collateral Engine


## 11. Credit Underwriting & Dynamic Credit Line


## 12. Risk Engine & Liquidation


## 13. Card & Payment Experience


## 14. Stablecoin Settlement Layer


## 15. Rewards & Premium Benefits


## 16. AI Wealth & Credit Agent


## 17. Security, Fraud & Trust


## 18. Regulatory / Operating Model


## 19. Technical Architecture


## 20. Data Model


## 21. API Requirements


## 22. Admin & Operations Console


## 23. MVP Requirements


## 24. V2–V4 Roadmap


## 25. Business Model & Unit Economics


## 26. KPIs & Analytics


## 27. Competitive Positioning


## 28. Risks & Mitigations


## 29. Team & Hiring Plan


## 30. Launch Plan


## 31. Open Decisions


## 32. Definition of Done


## 1. Executive Summary

The Global Wealth Card is a premium Visa/Mastercard product that converts verified financial wealth into usable consumer credit. Customers can pledge or otherwise make eligible assets available as collateral under the applicable lending/custody structure, receive a dynamically calculated spending limit, and use a normal card at everyday merchants.
The first version should focus on BTC and regulated stablecoins such as USDC in a single launch jurisdiction, using licensed partners for lending, custody, card issuing/processing and compliance. The company should own the customer experience, wealth graph, asset eligibility model, collateral optimization, dynamic credit/risk engine, rewards layer and AI financial agent.
The product is deliberately not positioned as a “crypto card.” The strategic positioning is: “Your wealth is your credit” and “Spend without selling.” Crypto is the initial wedge; the long-term platform is multi-asset.
A successful MVP proves that affluent and investment-active consumers value an asset-backed spending line enough to move meaningful assets, card spend and financial activity onto the platform.

## 2. Product Vision & Strategic Thesis


### 2.1 Vision

Become the global spending and credit layer for a customer’s verified wealth.
CUSTOMER WEALTH
|
+--------+--------+
|        |        |
BTC      Stablecoins  Securities
|        |        |
+--------+--------+
|
WEALTH GRAPH
|
AI RISK + CREDIT
|
CREDIT LINE
|
WEALTH CARD
|
VISA / MASTERCARD
|
MERCHANT

### 2.2 Strategic thesis

Traditional credit evaluates primarily income, credit history and unsecured risk; this product adds verified asset wealth and collateral quality.
Existing crypto spending products can make crypto spendable, but the stronger consumer proposition is to borrow against assets rather than sell them.
Stablecoins are more valuable as a settlement/liquidity layer than as something the customer must understand at checkout.
The card is the acquisition and transaction interface; the real moat is the wealth graph + collateral engine + underwriting + AI agent.
The product should expand from crypto collateral to a universal multi-asset wealth platform.

## 3. Problem Statement

Liquidity mismatch
A customer may have substantial wealth in BTC, equities, ETFs or cash equivalents but may not want to liquidate investments for a purchase.
Fragmented financial life
Assets are spread across exchanges, wallets, brokers and banks. Credit is typically disconnected from the full balance sheet.
Crypto spending friction
Direct crypto spending creates conversion, tax, volatility and merchant acceptance complexity.
Traditional premium cards are disconnected from wealth
High net worth does not automatically translate into a meaningfully higher card limit or better liquidity experience.
Cross-border friction
International customers face FX, settlement and banking friction even when they have globally mobile assets.
Risk complexity
Asset-backed credit requires real-time valuation, collateral haircuts, concentration controls, margin management and liquidation processes.

## 4. Product Goals & Non-Goals


### 4.1 Goals

Enable everyday spending against eligible wealth without requiring an asset sale at the point of purchase.
Provide a premium Visa/Mastercard experience with broad merchant acceptance.
Support BTC and stablecoins in the first product version.
Create a configurable multi-asset collateral framework for future stocks, ETFs, bonds and cash equivalents.
Calculate and adjust credit capacity using collateral value, asset risk, liquidity, concentration, income and repayment behavior.
Use stablecoins where they improve treasury, liquidity or cross-border settlement economics.
Deliver competitive rewards and premium benefits.
Build a trustworthy AI layer that explains credit capacity and financial risk rather than acting as an opaque black box.
Use licensed partners where required rather than prematurely owning every regulated function.

### 4.2 Non-goals for MVP

Launching in every country at once.
Supporting dozens of long-tail cryptocurrencies.
Building a proprietary blockchain.
Replacing Visa or Mastercard.
Becoming a full bank on day one.
Offering unrestricted unsecured credit.
Building full autonomous investment management before the core card/credit product is proven.

## 5. Target Customers & Personas

Persona
Profile
Primary Pain
Why They Care
Crypto Wealth Customer
$100K–$10M+ in BTC/stablecoins
Does not want to sell crypto for liquidity
Credit against assets + global spend
Investor
$250K+ in stocks/ETFs
Assets are valuable but illiquid for spending
Potential future multi-asset credit
Founder / Entrepreneur
High assets, variable income
Traditional underwriting may understate capacity
Asset + behavior-based underwriting
Global Professional
Multi-country income/assets
FX and cross-border friction
Stablecoin-enabled global spending
Premium Traveler
High monthly travel spend
Wants rewards/lounges and higher limits
Premium card experience

## 6. Product Principles

Hide complexity: Customers should see a normal premium card. Blockchain and collateral mechanics remain behind the scenes unless relevant.
Never optimize for growth at the expense of solvency: Credit expansion must be constrained by conservative collateral and liquidity rules.
Transparent risk: Customers must understand what collateral supports their credit and what can trigger restrictions or liquidation.
Asset-agnostic architecture: Design around an asset eligibility abstraction, not a crypto-only model.
Partner-first regulation: Use licensed institutions and providers where required.
Real-time where risk matters: Market value, LTV, available credit and fraud controls should update quickly enough for the risk profile.
Premium from day one: The experience should compete with premium cards, not look like an experimental crypto product.

## 7. Core User Journeys

Onboarding
Sign up → Identity/KYC checks → Connect wallet and/or eligible financial account → Verify asset ownership and value → Review credit terms and collateral agreement → Receive provisional or final limit → Issue virtual card → Issue physical card
Everyday purchase
User taps card → Authorization engine checks available credit and risk → Transaction is approved/declined → Merchant receives normal card-network settlement → Collateral/credit balance updates → Rewards post
Large purchase
User initiates purchase → System evaluates available credit → If needed, user receives a risk/limit explanation → Transaction is processed → AI explains impact on utilization and spending power
Market drawdown
Collateral value declines → Risk engine recalculates LTV/health → Customer receives alert if threshold is crossed → Credit availability can be reduced → If required by contract, customer can add collateral/repay; liquidation follows defined rules
Repayment
Customer pays in supported fiat/stablecoin → Balance updates → Credit becomes available again subject to risk rules → Rewards remain visible
International spend
Customer spends in local currency → FX/settlement layer handles conversion → Customer sees transparent FX rate/fee → Merchant receives local settlement

## 8. Product Scope

Module
MVP
V2
Long-Term
Identity/KYC
Yes
Yes
Yes
BTC collateral
Yes
Yes
Yes
Stablecoin collateral
Yes
Yes
Yes
ETH
No
Yes
Yes
US stocks/ETFs
No
Yes
Yes
Bonds/Treasuries
No
Optional
Yes
Global assets
No
No
Yes
Visa/Mastercard
One network
Both / more markets
Global multi-network
Rewards
Basic
Enhanced
Dynamic
Lounges
Premium partner
Expanded
Global premium
AI risk assistant
Basic
Advanced
Agentic
Multi-currency
Limited
Yes
Global

## 9. Wealth Graph & Asset Aggregation

The Wealth Graph is the canonical internal representation of a customer’s assets, liabilities, ownership, liquidity and risk characteristics.

### 9.1 Asset ingestion

Wallet connections and on-chain verification for supported digital assets.
Exchange/custodian integrations where available.
Brokerage integrations for future securities support.
Bank/account aggregation for cash and income signals where legally permissible.
Manual asset verification only as an exception and subject to enhanced review.

### 9.2 Required fields

Field
Description
asset_id
Unique asset/account identifier
asset_type
BTC, stablecoin, ETF, equity, cash, etc.
owner
Verified beneficial owner
custodian
Where the asset is held
quantity
Units held
market_value
Current value
currency
Valuation currency
liquidity_score
Estimated liquidation liquidity
volatility_score
Risk characteristic
concentration
Share of customer collateral
eligibility
Whether usable as collateral
haircut
Collateral haircut
last_verified_at
Last verification timestamp

## 10. Asset Eligibility & Collateral Engine

The collateral engine determines how much value can support credit. It must be configurable by jurisdiction, product, asset, custodian and lending partner.

### 10.1 Conceptual formula

Eligible Collateral Value = Market Value × Eligibility Factor × (1 − Haircut) × Liquidity Adjustment

### 10.2 Illustrative asset policy

Asset Class
Illustrative Risk Tier
Collateral Treatment
Regulated stablecoin
Low
High potential eligibility, subject to issuer/jurisdiction/custody risk
BTC
High volatility
Conservative haircut and dynamic monitoring
ETH
High volatility
Conservative haircut and dynamic monitoring
Broad-market ETF
Medium
Potential future eligibility
Individual equity
Medium/High
Lower factor and concentration controls
US Treasury / cash equivalent
Low
Potential high eligibility
Illiquid token
Very high
Likely excluded from MVP
Important: the above are product-design categories, not final lending terms. Final LTVs, haircuts and eligibility must be established by the regulated lender, legal counsel and risk committee.

## 11. Credit Underwriting & Dynamic Credit Line


### 11.1 Underwriting inputs

Eligible collateral value
Asset volatility and liquidity
Collateral concentration
Customer income and cash-flow signals where permitted
Credit history and repayment behavior
Existing debt
Account tenure
Fraud/risk score
Jurisdiction and regulatory eligibility
Stress-test results

### 11.2 Dynamic limit framework

Credit Capacity
= Base Collateral Capacity
× Portfolio Risk Adjustment
× Liquidity Adjustment
× Concentration Adjustment
× Customer/Repayment Adjustment
− Existing Exposure

### 11.3 Limit states

State
Meaning
Customer Experience
Healthy
Normal collateral buffer
Full available credit
Watch
Risk approaching threshold
Informational alert
Restricted
Credit capacity reduced
New spending limited or capped
Remediation
Collateral/repayment action required
Add collateral or repay
Liquidation
Contractual liquidation conditions reached
Defined forced-action process

## 12. Risk Engine & Liquidation


### 12.1 Real-time monitoring

Asset prices
FX rates
Volatility
Liquidity
LTV
Health factor
Collateral concentration
Credit utilization
Fraud signals
Market stress indicators

### 12.2 Stress testing

The platform should simulate adverse moves such as BTC drawdowns, stablecoin depegging scenarios, equity declines, FX shocks and liquidity deterioration. The output should estimate whether collateral remains sufficient under contractual requirements.

### 12.3 Liquidation design requirements

Document exact trigger conditions in customer agreements.
Provide warnings and remediation windows where legally/contractually required.
Prioritize orderly, liquidity-aware liquidation.
Use configurable asset priority rules.
Record every risk decision and action in an immutable audit trail.
Separate automated execution from model experimentation; production liquidation rules must be deterministic, testable and governed.

## 13. Card & Payment Experience


### 13.1 Card requirements

Visa or Mastercard network connectivity through an approved issuer/processor
Virtual and physical cards
Apple Pay and Google Pay where supported
Contactless
International transactions
ATM support where permitted
Merchant category controls
Freeze/unfreeze
Real-time transaction notifications
Dispute/chargeback support

### 13.2 Everyday categories

Groceries
Fuel / EV charging
Dining
Travel and hotels
Retail and e-commerce
Subscriptions
Utilities where supported

### 13.3 Checkout principle

The customer should not need to choose BTC, USDC or another asset for each transaction. The card should behave like a normal premium credit card.

## 14. Stablecoin Settlement Layer

Stablecoins should be treated as an optional infrastructure layer for treasury, liquidity and cross-border settlement. The merchant should generally receive ordinary local currency through the card network and acquiring ecosystem.
Customer assets
↓
Collateral / credit facility
↓
Liquidity / treasury
↓
Stablecoin rail (where efficient and permitted)
↓
FX / local settlement
↓
Visa / Mastercard
↓
Merchant

### 14.1 Requirements

Stablecoin whitelist by jurisdiction
Depeg monitoring
Issuer and reserve-risk monitoring
On/off-ramp controls
Blockchain fee monitoring
Transaction screening
Travel Rule / AML controls where applicable
24/7 operational monitoring for crypto settlement

## 15. Rewards & Premium Benefits


### 15.1 Rewards

Rewards should be designed to compete with premium cards while remaining economically sustainable after interchange, funding costs, fraud, credit losses and partner fees.
Tier
Illustrative Positioning
Potential Benefits
Wealth
Entry premium
Base points/cashback, digital card
Wealth+
Affluent
Higher rewards, lounge access, travel benefits
Private
HNW
Enhanced rewards, premium travel, concierge, higher limits
Ultra
Invitation-only
Bespoke limits, elite travel/concierge and experiences

### 15.2 Rewards currency

Proprietary points, e.g. WealthPoints.
Potential redemption into statement credit, travel, hotel/airline programs, cashback or eligible digital assets subject to local rules.
Dynamic category rewards can be introduced after the base economics are validated.

## 16. AI Wealth & Credit Agent

The AI layer should initially be advisory and explanatory. It should not autonomously move assets or change contractual credit terms without explicit controls, authorization and regulatory review.

### 16.1 MVP capabilities

Explain current credit limit
Explain why available credit changed
Summarize collateral health
Warn about concentration
Explain major market-driven changes
Answer “How much can I safely spend?”
Explain transaction impact on utilization
Generate personalized alerts

### 16.2 Future agent capabilities

Compare liquidity options
Recommend the lowest-cost permitted source of liquidity
Suggest collateral rebalancing
Coordinate repayment reminders
Optimize rewards
Coordinate investment/credit decisions across the Wealth OS

### 16.3 AI guardrails

Never fabricate balances or market data.
Show data timestamp/source for important financial values.
Separate factual account information from recommendations.
Explain uncertainty.
Do not execute high-impact financial actions without explicit authorization.
Maintain model/version audit logs.
Provide deterministic fallback for credit/risk decisions.

## 17. Security, Fraud & Trust


### 17.1 Account security

Passkeys / strong authentication
Biometric authentication
Device binding
Session risk
Transaction signing for sensitive asset actions
Withdrawal/address controls
Card freeze/unfreeze

### 17.2 Fraud engine

Merchant anomaly
Geographic anomaly
Velocity
Device/account takeover
Impossible travel
Behavioral deviation
Crypto transaction risk
Identity mismatch

### 17.3 Trust principles

Clear custody disclosures
Clear collateral terms
Visible available credit
Visible health/risk state
Clear fees
Human support for high-impact events
Full audit trail

## 18. Regulatory / Operating Model

The product must be designed around a jurisdiction-specific regulated operating model. The company should not assume that one legal structure works globally.

### 18.1 Potential regulated functions

Card issuance
Consumer lending
Crypto custody
Securities custody
Money transmission/payment services
Stablecoin conversion
Foreign exchange
KYC/AML and sanctions
Securities-backed lending
Consumer protection

### 18.2 Partner-first launch model

Startup owns:
• Brand / UX
• Wealth Graph
• Asset Eligibility Engine
• Credit / Risk Intelligence
• AI
• Rewards
• Customer experience
Partners provide where required:
• Regulated lending
• Card issuing / BIN sponsorship
• Card processing
• Crypto custody
• Brokerage / securities custody
• Stablecoin infrastructure
• KYC / AML
• FX / treasury

### 18.3 Jurisdiction strategy

Select one initial market where the intended lending, crypto custody, card issuance and stablecoin flows can be structured cleanly. Only after the legal and operating model is proven should the product expand to additional jurisdictions.

## 19. Technical Architecture

MOBILE / WEB
|
API GATEWAY
|
+---------------------+----------------------+
|                     |                      |
Identity Service       Card Service          AI Agent
|                     |                      |
KYC / AML             Processor APIs        AI Decision Layer
|
Wealth Service
|
+-----+------+-------------------+
|            |                   |
Wallets     Brokerage            Banks
|            |                   |
+------------+-------------------+
|
Valuation Engine
|
Collateral Engine
|
Credit Engine
|
Risk Engine
|
Liquidity / Lending
|
+-------+-------+
|               |
Crypto           Securities
Custody          Custody
|
Visa/Mastercard

### 19.1 Core services

Identity & KYC Service
Asset Aggregation Service
Valuation Service
Collateral Service
Credit Service
Risk Service
Card Service
Rewards Service
AI Service
Notification Service
Audit Service
Admin/Operations Service

### 19.2 Non-functional requirements

High availability for authorization and risk-critical services.
Strong encryption in transit and at rest.
Least-privilege access.
Complete auditability of credit/risk decisions.
Idempotent payment and settlement operations.
Event-driven architecture for market and transaction updates.
Disaster recovery and business continuity.
Observability: logs, metrics, traces and alerting.
Strict separation between production risk rules and experimental ML models.

## 20. Data Model

Entity
Core Attributes
User
identity, jurisdiction, status, risk profile
Account
custodian, account type, verification state
Asset
type, quantity, value, currency, eligibility
CollateralPosition
asset, haircut, eligible value, LTV contribution
CreditFacility
limit, balance, APR/fees, status
Card
PAN/token reference, status, network, controls
Transaction
merchant, amount, currency, MCC, auth status
RewardLedger
points earned, pending, redeemed
RiskSnapshot
LTV, health factor, concentration, timestamp
Alert
type, severity, status, action
LiquidationEvent
trigger, assets, execution, outcome
AIInteraction
intent, inputs, response, policy checks, audit data

## 21. API Requirements

API
Purpose
GET /wealth
Return verified assets, total wealth and allocation
GET /collateral
Return eligible collateral and haircuts
GET /credit
Return credit limit, balance and available credit
GET /risk
Return LTV, health and risk state
POST /card/authorize
Process or support transaction authorization
GET /transactions
Transaction history
GET /rewards
Rewards balance and ledger
POST /repayment
Initiate supported repayment
POST /collateral/add
Add eligible collateral
POST /collateral/release
Request release subject to risk rules
GET /alerts
Risk/fraud/credit alerts
POST /ai/query
AI financial assistant request
API contracts must include idempotency, authorization scopes, timestamps, currency precision, asset-price timestamps and audit identifiers.

## 22. Admin & Operations Console

Customer search and KYC status
Asset verification
Credit limit and exposure view
Collateral health
Risk alerts
Fraud alerts
Card status
Transaction investigation
Chargebacks/disputes
Rewards adjustments
Liquidation workflow
Partner settlement reconciliation
Audit logs
Model/risk parameter versioning
No single operations user should be able to bypass critical risk controls. High-impact actions should require role-based access and, where appropriate, dual approval.

## 23. MVP Requirements


### 23.1 MVP definition

A narrowly scoped product using BTC + one or more legally supported stablecoins, one launch jurisdiction, one card network, one regulated lending structure and one custody model.

### 23.2 Must-have features

Onboarding and KYC
Wallet connection and asset verification
BTC/stablecoin valuation
Collateral eligibility
Credit limit calculation
Real-time/near-real-time LTV monitoring
Credit facility ledger
Virtual card
Physical card
Apple Pay/Google Pay where available
Merchant transaction processing
Fiat merchant settlement
Repayment
Basic rewards
Risk alerts
Fraud controls
Admin console
AI credit/risk explanation
Audit logs

### 23.3 MVP success criteria

Customer can onboard, verify assets and receive a compliant credit decision.
Customer can spend at normal merchants without needing crypto knowledge.
Merchant receives normal settlement.
Credit and collateral balances reconcile accurately.
Risk engine catches defined adverse scenarios in testing.
Customer can understand why their limit changed.
Fraud, disputes and customer support workflows are operational.

## 24. V2–V4 Roadmap

Phase
Major Capabilities
Strategic Objective
V1 / MVP
BTC + stablecoin, one market, premium card, basic AI/risk
Prove demand and credit economics
V2
ETH, equities/ETFs, richer rewards, lounges, multi-currency
Become multi-asset
V3
Global assets, more jurisdictions, tokenized securities, advanced AI
Become Global Wealth Card
V4
AI financial agent, automated liquidity optimization, broader financial products
Become Wealth Operating System

## 25. Business Model & Unit Economics


### 25.1 Revenue streams

Interchange economics
Interest / credit spread
Premium subscription
FX economics where permitted
Partner revenue
Potential wealth-management revenue in applicable jurisdictions
Potential lending/treasury spread where legally structured

### 25.2 Major costs

Card network/issuer/processor fees
Funding cost
Rewards
Credit losses
Fraud losses
Custody and blockchain costs
KYC/AML
Cloud/data/market data
Customer support
Legal/compliance

### 25.3 Economic principle

The product should not rely on aggressive interest income or high customer leverage to appear profitable. Sustainable economics should come from a mix of card spend, premium membership, responsible credit economics and broader financial-product engagement.

## 26. KPIs & Analytics


### 26.1 North Star

Risk-adjusted annual spend per verified wealth customer, supported by healthy collateral and repayment behavior.
Category
Metrics
Acquisition
CAC, KYC completion, approval rate, asset connection rate
Activation
Card activation, first transaction, wallet/card provisioning
Wealth
Assets connected, eligible collateral, average wealth
Credit
Average limit, utilization, repayment, delinquency, loss rate
Risk
LTV, health factor, margin events, liquidation rate
Payments
Monthly spend, transactions, authorization approval rate
Rewards
Points earned, redemption, reward cost as % of spend
Retention
30/90/180-day retention, monthly active spenders
Economics
Revenue/customer, gross margin, CAC payback, LTV
Trust
Fraud loss, dispute rate, support resolution time

## 27. Competitive Positioning

Category
Typical Proposition
Our Differentiation
Crypto debit card
Spend crypto balance
Borrow against wealth and spend
Crypto-backed lender
Borrow against crypto
Turn credit facility into a premium everyday card
Traditional credit card
Unsecured credit based on credit profile
Asset + income + behavior + risk-aware credit
Stablecoin card infrastructure
Stablecoin-funded card issuance
Consumer wealth graph + credit + rewards + AI
Broker / wealth manager
Invest and manage assets
Invest + borrow + spend in one system
Private bank
Wealth + lending + concierge
AI-native, global and programmable wealth/credit layer

## 28. Risks & Mitigations

Risk
Severity
Mitigation
Regulatory uncertainty
Very High
Jurisdiction-first legal design; regulated partners
Collateral volatility
Very High
Conservative haircuts, dynamic LTV, stress testing
Liquidation / market gap risk
Very High
Liquidity-aware rules, buffers, multiple venues
Credit losses
High
Collateral + underwriting + exposure limits
Stablecoin depeg
High
Whitelist, reserve/issuer monitoring, exposure caps
Fraud / account takeover
High
Device intelligence, MFA, AI fraud controls
Partner dependency
High
Multi-provider architecture and contractual SLAs
Rewards economics
Medium
Cap rewards; category controls; unit-economic monitoring
User misunderstanding
High
Clear disclosures and AI explanations
Operational reconciliation
High
Double-entry ledgers and automated reconciliation

## 29. Team & Hiring Plan

Function
Initial Roles
Priority
Product
Head of Product, Product Manager
P0
Engineering
CTO/Tech Lead, Backend, Mobile, Platform
P0
Risk
Chief Risk/credit lead, Quant/Risk engineer
P0
Compliance
Compliance lead, AML/KYC specialists
P0
Security
Security engineer / advisor
P0
Crypto
Blockchain/custody engineer
P0
Payments
Payments/card integration lead
P0
Design
Product designer
P1
Data/AI
ML/AI engineer, data engineer
P1
Finance/Treasury
Treasury/finance lead
P1
Partnerships
Bank/card/custody partnerships
P0

## 30. Launch Plan


### 30.1 Stage 0 — Feasibility

Select launch jurisdiction.
Obtain legal opinions on collateral/lending/card/stablecoin structure.
Shortlist bank/lender, card issuer/processor and custody partners.
Define asset eligibility and risk committee charter.
Build detailed unit economics.

### 30.2 Stage 1 — Closed alpha

100–500 invited users.
BTC + stablecoin only.
Conservative limits.
Manual oversight of high-risk events.
Measure spend, retention, collateral movement and support issues.

### 30.3 Stage 2 — Beta

1,000–5,000 users.
Automate onboarding and routine risk.
Launch rewards.
Launch premium card benefits.
Establish credit-loss and fraud baselines.

### 30.4 Stage 3 — Public launch

Expand acquisition.
Add referral program.
Expand rewards partners.
Add additional asset classes only after risk/economics validation.

## 31. Open Decisions

Launch jurisdiction: US vs another crypto-friendly regulated market.
Visa vs Mastercard for initial program.
Custody model: customer-controlled vs institutional/partner custody.
Credit structure: crypto-backed loan, secured revolving facility, or other permitted structure.
Stablecoin whitelist.
Whether securities collateral is introduced in V2 or earlier.
Rewards currency and funding model.
Interest-bearing vs interest-free grace-period product design.
Premium annual fee.
Credit limit philosophy and risk appetite.
Whether the long-term product should be combined with the AI Wealth OS.

## 32. Definition of Done

The MVP is considered ready for controlled launch only when all of the following are true:
Legal and regulatory structure approved for the launch jurisdiction.
Licensed partners contracted and operational.
End-to-end KYC and customer onboarding works.
Assets can be verified and valued accurately.
Collateral engine produces deterministic, auditable results.
Credit engine produces approved limits within policy.
Card transactions authorize and settle correctly.
Merchant settlement reconciles.
Repayments reconcile to the credit ledger.
Risk engine handles defined market stress scenarios.
Fraud controls and dispute workflows are operational.
Customer disclosures and collateral terms are approved.
AI assistant passes factuality, safety and policy evaluations.
Production monitoring, incident response and disaster recovery are tested.
Security review and penetration testing are complete.
Operations team can investigate and resolve customer/risk/payment issues.
Unit economics are tracked from day one.

## Appendix A — Example Customer Experience

Customer Wealth
$550,000
BTC                    $150,000
USDC                    $50,000
US equities             $200,000
ETFs                    $100,000
Cash                     $50,000
----------
Total                   $550,000
Eligible collateral     $450,000
Approved credit         $150,000
Current balance           $8,400
Available credit         $141,600
Portfolio health             92%
Customer spends $1,200 on groceries.
Merchant: receives normal card settlement.
Customer: keeps underlying assets subject to collateral terms.
System: records $1,200 utilization and posts rewards.
AI: updates spending/risk explanation if material.
The numbers above are illustrative product examples only and are not recommended lending terms.

## Appendix B — Product North Star

The company should feel to the customer like a premium global financial institution, while internally operating as an AI-native asset, credit and payments platform.
The long-term flywheel is:
More verified wealth
↓
Better wealth graph
↓
Better underwriting
↓
More responsible credit
↓
More card spend
↓
More revenue + engagement
↓
More assets connected
↓
Stronger financial relationship
