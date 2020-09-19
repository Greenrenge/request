process.env.NODE_ENV = "test"
const mockedEnv = require("mocked-env")

describe("Test", () => {
  let restore
  before(() => {
    restore = mockedEnv({
      NODE_ENV: "production",
    })
  })
  after(() => {
    restore()
  })
  context("change env to production", () => {
    it("should change env to production", () => {
      process.env.NODE_ENV.should.be.eq("production")
    })
  })
})
