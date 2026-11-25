import { parseAbi } from 'viem'

/** The subset of the Safe singleton ABI (v1.3.0 – v1.5.0) this app uses. */
export const safeAbi = parseAbi([
  'function VERSION() view returns (string)',
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function isOwner(address owner) view returns (bool)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function approvedHashes(address owner, bytes32 hash) view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'function approveHash(bytes32 hashToApprove)',
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function changeThreshold(uint256 _threshold)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
  'event ApproveHash(bytes32 indexed approvedHash, address indexed owner)',
])

/** Safe Allowance Module (identical external ABI for v0.1.0, v0.1.1 and v1.0.0). */
export const allowanceModuleAbi = parseAbi([
  'function NAME() view returns (string)',
  'function VERSION() view returns (string)',
  'function addDelegate(address delegate)',
  'function removeDelegate(address delegate, bool removeAllowances)',
  'function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)',
  'function resetAllowance(address delegate, address token)',
  'function deleteAllowance(address delegate, address token)',
  'function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)',
  'function generateTransferHash(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, uint16 nonce) view returns (bytes32)',
  'function getTokens(address safe, address delegate) view returns (address[])',
  'function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])',
  'function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, uint48 next)',
  'event AddDelegate(address indexed safe, address delegate)',
  'event RemoveDelegate(address indexed safe, address delegate)',
  'event ExecuteAllowanceTransfer(address indexed safe, address delegate, address token, address to, uint96 value, uint16 nonce)',
  'event PayAllowanceTransfer(address indexed safe, address delegate, address paymentToken, address paymentReceiver, uint96 payment)',
  'event SetAllowance(address indexed safe, address delegate, address token, uint96 allowanceAmount, uint16 resetTime)',
  'event ResetAllowance(address indexed safe, address delegate, address token)',
  'event DeleteAllowance(address indexed safe, address delegate, address token)',
])

export const erc20Abi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

export const multiSendAbi = parseAbi(['function multiSend(bytes transactions) payable'])
